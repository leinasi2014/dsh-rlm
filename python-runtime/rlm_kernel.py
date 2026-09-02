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
MAX_QUERY_TEXT = 64 * 1024
MAX_FRAME_BYTES = 256 * 1024
MAX_ERROR_TEXT = 64 * 1024
CELL_FILENAME = "<rlm-cell>"


class RlmQueryError(Exception):
    """Raised in a cell when the host fails to satisfy an rlm_query call."""

    def __init__(
        self,
        message: str,
        detail: Optional[Any] = None,
        truncated: bool = False,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail
        self.truncated = truncated


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
        self.query_truncated = False
        self.failed: Optional[str] = None
        # The pipe stream frames go to even while sys.stdout is swapped to a
        # bounded capture during a cell.
        self._real_stdout = sys.stdout

    # ---- framing ----

    _SHRINKABLE_FIELDS = ("message", "text", "detail", "stdout", "result")

    @staticmethod
    def _sanitize_wire_text(s: str) -> str:
        # Lone surrogates become their literal \\udXXX escape text, which is a
        # valid JSON escape inside a string; the host parser restores the
        # original surrogate semantics. Ordinary Unicode is unchanged.
        return s.encode("utf-8", "backslashreplace").decode("utf-8")

    @classmethod
    def _wire_bytes(cls, frame: dict[str, Any]) -> int:
        # Exact serialized JSONL wire bytes (text + trailing newline), counted
        # the same way the line is written: surrogates sanitized, ordinary
        # Unicode kept literal (no 6x escape blowup).
        line = cls._sanitize_wire_text(json.dumps(frame, ensure_ascii=False))
        return len(line.encode("utf-8")) + 1

    def _send(self, frame: dict[str, Any]) -> None:
        # Wire guard: every Python->Host JSONL line (including the newline)
        # must stay within MAX_FRAME_BYTES. result/error frames adaptively
        # shrink their bounded text fields (never cutting serialized JSON
        # bytes) and are flagged truncated; other frames that cannot fit are
        # an unrecoverable protocol fault.
        if frame.get("type") in ("result", "error"):
            while True:
                if self._wire_bytes(frame) <= MAX_FRAME_BYTES:
                    break
                best: Optional[str] = None
                best_len = -1
                for field in self._SHRINKABLE_FIELDS:
                    value = frame.get(field)
                    if isinstance(value, str):
                        size = len(value.encode("utf-8", "backslashreplace"))
                        if size > best_len:
                            best, best_len = field, size
                if best is None or best_len <= 0:
                    self._fatal("protocol frame exceeds 256 KiB and cannot be shrunk")
                    return
                # Monotonic progress: halving a 1-byte field to 0 is real
                # progress, so each pass strictly shrinks the largest bound
                # text field or fatals; the same string is never written back
                # into an infinite loop.
                shrunk, _ = self._cut(frame[best], max(0, best_len // 2))
                if shrunk == frame[best]:
                    self._fatal("protocol frame exceeds 256 KiB and cannot be shrunk")
                    return
                frame[best] = shrunk
                frame["truncated"] = True
        elif self._wire_bytes(frame) > MAX_FRAME_BYTES:
            self._fatal("protocol frame exceeds 256 KiB")
            return
        # Write through the same TextIOWrapper a cell's sys.__stdout__ uses, so
        # frames and direct cell writes share one ordered stream; the text is
        # pre-sanitized so the strict UTF-8 encoder never sees a surrogate.
        self._real_stdout.write(
            self._sanitize_wire_text(json.dumps(frame, ensure_ascii=False)) + "\n"
        )
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
        # Bound every Host→Python JSONL line at MAX_FRAME_BYTES including the
        # trailing '\n'. We read the binary pipe in bounded chunks (never `for
        # line in sys.stdin`, which can buffer an unbounded line) and fatal the
        # process on an over-long frame, a frame that ends without a newline, or
        # a strict UTF-8 decode failure.
        stdin = sys.stdin.buffer
        while True:
            # Bound every Host→Python JSONL line at MAX_FRAME_BYTES including
            # the trailing '\n'. Read with a limit of exactly MAX_FRAME_BYTES
            # so a line that already holds the maximum legal length without a
            # newline is returned here instead of waiting for byte 262145.
            line = stdin.readline(MAX_FRAME_BYTES)
            if not line:
                # stdin closed cleanly between frames: release any pending query
                # so the loop can wind down.
                for future in list(self.pending.values()):
                    self.loop.call_soon_threadsafe(
                        future.set_exception,
                        RlmQueryError("kernel: host closed the pipe"),
                    )
                self.loop.call_soon_threadsafe(self.queue.put_nowait, None)
                return
            if len(line) >= MAX_FRAME_BYTES and not line.endswith(b"\n"):
                # The buffer is already at the maximum legal frame length with
                # no newline: any further byte would exceed the cap, so fatal
                # now instead of blocking for the 262145th byte.
                self._fatal("protocol frame exceeds 256 KiB")
                return
            if not line.endswith(b"\n"):
                self._fatal("protocol frame missing newline (256 KiB)")
                return
            payload = line[:-1]
            try:
                text = payload.decode("utf-8")
            except UnicodeDecodeError:
                self._fatal("protocol frame is not valid UTF-8")
                return
            if not text.strip():
                continue
            try:
                frame = json.loads(text)
            except json.JSONDecodeError:
                self._fatal("invalid JSON frame: " + text[:200])
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
                    text = str(frame.get("text", ""))
                    truncated = frame.get("truncated") is True
                    self.loop.call_soon_threadsafe(
                        future.set_result, (text, truncated)
                    )
                else:
                    message = str(frame.get("message", "rlm_query failed"))
                    detail = frame.get("detail")
                    truncated = frame.get("truncated") is True
                    self.loop.call_soon_threadsafe(
                        future.set_exception,
                        RlmQueryError(message, detail, truncated),
                    )
            else:
                self._fatal("unexpected message type: " + repr(kind))
                return

    # ---- query bridge ----

    async def _rlm_query(self, prompt: Any) -> str:
        prompt_str = str(prompt)
        if len(prompt_str.encode("utf-8", "backslashreplace")) > MAX_QUERY_TEXT:
            raise RlmQueryError("rlm_query prompt exceeds 64 KiB")
        qid = self.next_query_id
        self.next_query_id += 1
        query_frame = {"type": "query", "id": qid, "prompt": prompt_str}
        # A query frame that cannot fit the wire budget becomes a typed query
        # error for the cell instead of a silently broken protocol write.
        if self._wire_bytes(query_frame) > MAX_FRAME_BYTES:
            raise RlmQueryError("rlm_query frame exceeds 256 KiB wire budget")
        loop = asyncio.get_running_loop()
        future: "asyncio.Future[tuple[str, bool]]" = loop.create_future()
        self.pending[qid] = future
        self._send(query_frame)
        try:
            text, truncated = await future
            self.query_truncated = self.query_truncated or truncated
            return text
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
        # Iterate the ORIGINAL characters/code points and charge each one with
        # the same wire-safe measurement (backslashreplace per code unit), but
        # return the original character prefix: a lone surrogate stays a real
        # U+D800 code unit in the result and is never converted into the
        # literal escape text before the cut. The result is at most the budget,
        # never splits a character, and never introduces U+FFFD.
        budget = 0
        kept: list[str] = []
        for ch in text:
            cost = len(ch.encode("utf-8", "backslashreplace"))
            if budget + cost > limit_bytes:
                break
            kept.append(ch)
            budget += cost
        result = "".join(kept)
        if len(result) == len(text):
            return text, False
        return result, True

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

        # Reset the per-cell query truncation flag before the cell runs.
        self.query_truncated = False
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
                    eval_id, "query", "query_error", e, name="RlmQueryError"
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
            "truncated": capture.truncated or result_cut or stdout_cut or self.query_truncated,
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
        message, msg_cut = RlmKernel._cut(_safe_str(exc), MAX_ERROR_TEXT)
        # Bound non-shrinkable name metadata before frame construction: a
        # runtime-constructed exception type can carry an arbitrarily long
        # __name__, and the adaptive shrinker cannot cut it, so an unbounded
        # name would produce an over-budget frame with no progress path.
        raw_name = name or _safe_type_name(exc)
        bounded_name, name_cut = RlmKernel._cut(raw_name, MAX_ERROR_TEXT)
        frame: dict[str, Any] = {
            "type": "error",
            "id": eval_id,
            "phase": phase,
            "kind": kind,
            "message": message,
            "name": bounded_name,
        }
        lineno = _safe_attr(exc, "lineno")
        column = _safe_attr(exc, "offset")
        text = _safe_attr(exc, "text")
        text_cut = False
        # Numeric metadata is bounded before frame construction too: an
        # arbitrarily large int line/column would serialize to a huge digit
        # string that no shrinker could shorten; absurd values are omitted
        # (real source lines are small integers).
        if isinstance(lineno, int) and abs(lineno) <= 2**53 - 1:
            frame["line"] = lineno
        if isinstance(column, int) and abs(column) <= 2**53 - 1:
            frame["column"] = column
        if isinstance(text, str):
            bounded_text, text_cut = RlmKernel._cut(text, MAX_ERROR_TEXT)
            frame["text"] = bounded_text
        detail_cut = False
        detail = _safe_attr(exc, "detail")
        if detail is not None:
            try:
                # Detach into pure JSON-native values so the frame's send-time
                # serialization can never re-enter a hostile object: serialize
                # once (no NaN, non-ASCII kept) and re-parse immediately. Any
                # BaseException or NaN falls back to a safe string.
                detached = json.loads(
                    json.dumps(detail, ensure_ascii=False, allow_nan=False)
                )
            except BaseException:
                detached = _safe_str(detail)
            if isinstance(detached, str):
                bounded_detail, detail_cut = RlmKernel._cut(detached, MAX_ERROR_TEXT)
                frame["detail"] = bounded_detail
            else:
                # Small structured detail keeps its JSON-native type; an
                # oversized structured detail degrades to a bounded string.
                try:
                    as_text = json.dumps(detached, ensure_ascii=False)
                except BaseException:
                    as_text = _safe_str(detached)
                if len(as_text.encode("utf-8", "backslashreplace")) > MAX_ERROR_TEXT:
                    bounded_detail, detail_cut = RlmKernel._cut(
                        as_text, MAX_ERROR_TEXT
                    )
                    frame["detail"] = bounded_detail
                else:
                    frame["detail"] = detached
        exc_truncated = _safe_attr(exc, "truncated") is True
        if msg_cut or text_cut or detail_cut or name_cut or exc_truncated:
            frame["truncated"] = True
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
    # Use UTF-8 for the pipe regardless of the Windows console codepage. The
    # protocol stdout must be LF-only: with the default newline translation
    # Windows turns "\n" into os.linesep, so a frame the kernel counted as
    # json+1 wire bytes would actually hit the pipe as json+2 (CRLF).
    try:
        if sys.stdin is not None:
            sys.stdin.reconfigure(encoding="utf-8")
        if sys.stdout is not None:
            sys.stdout.reconfigure(encoding="utf-8", newline="\n")
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
