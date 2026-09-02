#!/usr/bin/env python3
"""dsh-rlm minimal Python kernel (M1A).

Speaks a small JSON-lines protocol on stdin/stdout with the TypeScript host:

  ready         kernel -> host  {type:ready, version, python}
  eval          host  -> kernel {type:eval, id, code, max_stdout?, max_result?}
  query         kernel -> host  {type:query, id, prompt}
  query_result  host  -> kernel {type:query_result, id, text}
  result        kernel -> host  {type:result, id, stdout, result?, truncated}
  error         kernel -> host  {type:error, id, phase:eval|query, kind, name?,
                                 message?, line?, column?, detail?}

The kernel keeps one persistent namespace across cells, supports top-level
await via ast.PyCF_ALLOW_TOP_LEVEL_AWAIT, and exposes await rlm_query(prompt)
which emits a query frame and resumes the cell when the host answers. A cell
produces exactly one terminal result or error; after an error the kernel stays
alive so the next eval can run.

Unparseable frames or unexpected traffic are protocol errors: the kernel logs
to stderr and exits nonzero (namespace is lost on the host side).
"""

from __future__ import annotations

import ast
import asyncio
import builtins
import inspect
import json
import os
import platform
import sys
import threading
from typing import Any, Optional

PROTOCOL_VERSION = 1
DEFAULT_MAX_STDOUT = 64 * 1024
DEFAULT_MAX_RESULT = 64 * 1024
CELL_FILENAME = "<rlm-cell>"


class RlmQueryError(Exception):
    """Raised in a cell when the host fails to satisfy an rlm_query call."""

    def __init__(self, message: str, detail: Optional[Any] = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail


class _BoundedStdout:
    """A file-like stdout that keeps only the first limit_bytes of output."""

    def __init__(self, limit_bytes: int) -> None:
        self._limit = limit_bytes
        self._stored: list[str] = []
        self._stored_bytes = 0
        self._total_bytes = 0

    def write(self, s: Any) -> int:
        s = str(s)
        b = len(s.encode("utf-8"))
        self._total_bytes += b
        if self._stored_bytes < self._limit:
            remain = self._limit - self._stored_bytes
            piece = s.encode("utf-8")[:remain].decode("utf-8", errors="ignore")
            self._stored.append(piece)
            self._stored_bytes += len(piece.encode("utf-8"))
        return len(s)

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        return False

    @property
    def encoding(self) -> str:
        return "utf-8"

    def value(self) -> str:
        return "".join(self._stored)

    @property
    def truncated(self) -> bool:
        return self._total_bytes > self._limit


def _safe_str(value: Any) -> str:
    """Best-effort str() that cannot raise: a hostile __str__ inside the
    error being reported must never turn a typed cell error into a kernel
    crash while building the error frame."""
    try:
        return str(value)
    except BaseException:
        return _safe_type_name(value)


def _safe_type_name(value: Any) -> str:
    """Best-effort exception class name that cannot raise: a hostile
    metaclass whose __name__ access throws must never turn a typed cell
    error into a kernel crash while building the error frame. The fallback
    is a stable string that keeps the frame well-formed."""
    try:
        return type(value).__name__
    except BaseException:
        return "BaseException"


def _safe_attr(obj: Any, name: str) -> Any:
    """getattr that cannot raise: a hostile exception whose attribute reads
    (e.g. lineno/offset/text/detail properties) throw again must not let
    error-frame construction escape as a kernel crash."""
    try:
        return getattr(obj, name)
    except BaseException:
        return None


class RlmKernel:
    def __init__(self) -> None:
        # Persistent globals shared across every cell of this process.
        self.namespace: dict[str, Any] = {
            "__name__": "__rlm__",
            "__builtins__": builtins,
            "asyncio": asyncio,
            "rlm_query": self._rlm_query,
        }
        self.loop: asyncio.AbstractEventLoop = asyncio.new_event_loop()
        self.queue: "asyncio.Queue[Optional[dict[str, Any]]]" = asyncio.Queue()
        self.pending: dict[int, asyncio.Future] = {}
        self.next_query_id = 1
        self.failed: Optional[str] = None
        # The pipe stream frames go to even while sys.stdout is swapped to a
        # bounded capture during a cell.
        self._real_stdout = sys.stdout

    # ---- framing ----

    def _send(self, frame: dict[str, Any]) -> None:
        # ASCII-safe wire encoding: every frame is written as pure-ASCII JSON
        # escapes, so a lone surrogate anywhere in a frame (message, detail,
        # text, result, stdout, query prompt) can never crash the strict UTF-8
        # pipe; the host JSON parser restores the original Unicode semantics.
        self._real_stdout.write(json.dumps(frame, ensure_ascii=True) + "\n")
        self._real_stdout.flush()

    def _fatal(self, message: str) -> None:
        """Record a fatal protocol error and terminate the process."""
        self.failed = message
        if sys.stderr is not None:
            try:
                sys.stderr.write("[dsh-rlm kernel] fatal: " + message + "\n")
                sys.stderr.flush()
            except Exception:
                pass
        os._exit(1)

    # ---- reader thread ----

    def _reader(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                self._fatal("invalid JSON frame: " + line[:200])
                return
            if not isinstance(frame, dict):
                self._fatal("frame is not an object")
                return
            kind = frame.get("type")
            if kind == "eval":
                self.loop.call_soon_threadsafe(self.queue.put_nowait, frame)
            elif kind in ("query_result", "error"):
                qid = frame.get("id")
                future = self.pending.pop(qid, None)
                if future is None:
                    self._fatal("response for unknown query id " + repr(qid))
                    return
                if kind == "query_result":
                    self.loop.call_soon_threadsafe(
                        future.set_result, str(frame.get("text", ""))
                    )
                else:
                    message = str(frame.get("message", "rlm_query failed"))
                    self.loop.call_soon_threadsafe(
                        future.set_exception,
                        RlmQueryError(message, frame.get("detail")),
                    )
            else:
                self._fatal("unexpected message type: " + repr(kind))
                return
        # stdin closed: release any pending query so the loop can wind down.
        for future in list(self.pending.values()):
            self.loop.call_soon_threadsafe(
                future.set_exception,
                RlmQueryError("kernel: host closed the pipe"),
            )
        self.loop.call_soon_threadsafe(self.queue.put_nowait, None)

    # ---- query bridge ----

    async def _rlm_query(self, prompt: Any) -> str:
        qid = self.next_query_id
        self.next_query_id += 1
        loop = asyncio.get_running_loop()
        future: "asyncio.Future[str]" = loop.create_future()
        self.pending[qid] = future
        self._send({"type": "query", "id": qid, "prompt": str(prompt)})
        try:
            return await future
        finally:
            self.pending.pop(qid, None)

    # ---- cell execution ----

    def _restore_scaffold(self) -> None:
        """Re-bind the official rlm_query bridge at every cell boundary.

        User code may legitimately shadow or delete any global (the namespace
        is deliberately not frozen), so the scaffold this kernel speaks is
        always self._rlm_query: it is re-injected before a cell and again in
        the outer finally that covers every success/error exit.
        """
        self.namespace["rlm_query"] = self._rlm_query

    @staticmethod
    def _compile_cell(code: str) -> "tuple[Any, Optional[Any]]":
        """Split a cell into its statement body and the final top-level
        expression. Both are compiled with PyCF_ALLOW_TOP_LEVEL_AWAIT so
        top-level await keeps working; a code object whose flags carry
        CO_COROUTINE is the coroutine to await. The expression value is
        captured in a local, never written into the user namespace."""
        tree = ast.parse(code, filename=CELL_FILENAME, mode="exec")
        body_nodes = list(tree.body)
        last: Optional[ast.Expr] = None
        if body_nodes and isinstance(body_nodes[-1], ast.Expr):
            last = body_nodes.pop()
        body_tree = ast.Module(body=body_nodes, type_ignores=tree.type_ignores)
        ast.fix_missing_locations(body_tree)
        body_code = compile(
            body_tree, CELL_FILENAME, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
        )
        expr_code: Optional[Any] = None
        if last is not None:
            expr_tree = ast.copy_location(ast.Expression(body=last.value), last)
            ast.fix_missing_locations(expr_tree)
            expr_code = compile(
                expr_tree, CELL_FILENAME, "eval", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
            )
        return body_code, expr_code

    @staticmethod
    def _format_result(value: Any) -> str:
        return value if isinstance(value, str) else repr(value)

    @staticmethod
    def _cut(text: str, limit_bytes: int) -> "tuple[str, bool]":
        data = text.encode("utf-8")
        if len(data) <= limit_bytes:
            return text, False
        return data[:limit_bytes].decode("utf-8", errors="ignore"), True

    async def _on_eval(self, frame: dict[str, Any]) -> None:
        eval_id = frame.get("id")
        code = frame.get("code")
        if not isinstance(eval_id, int) or not isinstance(code, str):
            self._fatal("malformed eval frame: " + repr(frame))
            return
        max_stdout = frame.get("max_stdout", DEFAULT_MAX_STDOUT)
        max_result = frame.get("max_result", DEFAULT_MAX_RESULT)
        if (
            not isinstance(max_stdout, int)
            or not isinstance(max_result, int)
            or max_stdout < 0
            or max_result < 0
        ):
            self._fatal("invalid limits in eval frame: " + repr(frame))
            return

        # Restore the official scaffold before every cell so a previous cell
        # that shadowed or deleted rlm_query cannot poison this one.
        self._restore_scaffold()

        capture = _BoundedStdout(max_stdout)
        old_stdout = sys.stdout
        sys.stdout = capture
        try:
            try:
                body_code, expr_code = self._compile_cell(code)
            except SyntaxError as e:
                self._send(self._error_frame(eval_id, "eval", "syntax_error", e))
                return
            except ValueError as e:
                # Defensive: an AST/compile failure must fail the cell, never the
                # whole kernel; report it as a typed error and keep serving eval.
                self._send(self._error_frame(eval_id, "eval", "compile_error", e))
                return

            coro = eval(body_code, self.namespace)  # type: ignore[arg-type]
            # Only a module compiled with top-level await yields a coroutine;
            # a plain module runs synchronously and eval returns None.
            if body_code.co_flags & inspect.CO_COROUTINE:
                await coro

            result: Optional[str] = None
            result_cut = False
            if expr_code is not None:
                value = eval(expr_code, self.namespace)
                if expr_code.co_flags & inspect.CO_COROUTINE:
                    value = await value
                if value is not None:
                    # Formatting and truncation stay inside the cell's error
                    # boundary and before sys.stdout is restored, so a raising
                    # __repr__ is a typed eval error, never a kernel crash, and
                    # cannot pollute the protocol pipe.
                    rendered = self._format_result(value)
                    result, result_cut = self._cut(rendered, max_result)
        except RlmQueryError as e:
            self._send(
                self._error_frame(
                    eval_id, "eval", "query_error", e, name="RlmQueryError"
                )
            )
            return
        except BaseException as e:
            self._send(self._error_frame(eval_id, "eval", "runtime_error", e))
            return
        finally:
            sys.stdout = old_stdout
            self._restore_scaffold()

        stdout, stdout_cut = self._cut(capture.value(), max_stdout)
        frame_out: dict[str, Any] = {
            "type": "result",
            "id": eval_id,
            "stdout": stdout,
            "truncated": capture.truncated or result_cut or stdout_cut,
        }
        if result is not None:
            frame_out["result"] = result
        self._send(frame_out)

    # ---- error helpers ----

    @staticmethod
    def _error_frame(
        eval_id: int,
        phase: str,
        kind: str,
        exc: BaseException,
        name: Optional[str] = None,
    ) -> dict[str, Any]:
        frame: dict[str, Any] = {
            "type": "error",
            "id": eval_id,
            "phase": phase,
            "kind": kind,
            "message": _safe_str(exc),
            "name": name or _safe_type_name(exc),
        }
        lineno = _safe_attr(exc, "lineno")
        column = _safe_attr(exc, "offset")
        text = _safe_attr(exc, "text")
        if isinstance(lineno, int):
            frame["line"] = lineno
        if isinstance(column, int):
            frame["column"] = column
        if isinstance(text, str):
            frame["text"] = text
        detail = _safe_attr(exc, "detail")
        if detail is not None:
            try:
                # Detach into pure JSON-native values so the frame's send-time
                # serialization can never re-enter a hostile object: serialize
                # once (no NaN, non-ASCII kept) and re-parse immediately. Any
                # BaseException or NaN falls back to a safe string.
                frame["detail"] = json.loads(
                    json.dumps(detail, ensure_ascii=False, allow_nan=False)
                )
            except BaseException:
                frame["detail"] = _safe_str(detail)
        return frame

    # ---- main loop ----

    async def run(self) -> None:
        self._send(
            {
                "type": "ready",
                "version": PROTOCOL_VERSION,
                "python": platform.python_version(),
            }
        )
        while True:
            frame = await self.queue.get()
            if frame is None:
                return
            kind = frame.get("type")
            if kind == "eval":
                await self._on_eval(frame)
            else:
                self._fatal("unexpected queued message type: " + repr(kind))
                return


def main() -> int:
    # Use UTF-8 for the pipe regardless of the Windows console codepage.
    try:
        if sys.stdin is not None:
            sys.stdin.reconfigure(encoding="utf-8")
        if sys.stdout is not None:
            sys.stdout.reconfigure(encoding="utf-8")
        if sys.stderr is not None:
            sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

    kernel = RlmKernel()
    reader = threading.Thread(target=kernel._reader, name="rlm-reader", daemon=True)
    reader.start()
    try:
        kernel.loop.run_until_complete(kernel.run())
    except Exception as e:
        kernel._fatal("kernel crashed: " + type(e).__name__ + ": " + str(e))
    finally:
        kernel.loop.close()
    return 1 if kernel.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
