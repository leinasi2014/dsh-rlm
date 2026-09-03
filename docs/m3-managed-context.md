# M3 Managed Context Architecture

> English (authoritative) | [简体中文](m3-managed-context.zh-CN.md)

## Outcome

M3 lets a caller provide one absolute UTF-8 file path with `rlm_eval`. The host
sends only that descriptor to the private kernel protocol; the kernel opens,
validates, decodes, and then atomically publishes the text as the protected
`context` global before the Python cell starts. The managed-loading path never
copies file bytes into model-visible tool arguments, host/kernel frames, or
tool results.

```ts
interface RlmEvalInput {
  code: string
  contextPath?: string
}
```

This is a small managed loading boundary, not a Context Domain, attachment
framework, chunker, index, or persistence layer. Python remains trusted local
execution and may still read files directly when managed loading is unnecessary.

## Contract

- `contextPath` is optional. Omitting it preserves the M1/M2 behavior exactly.
- A supplied path must be absolute and identify an existing regular file.
- The file must be strict UTF-8 and no larger than `maxContextBytes`.
- The host sends only the path descriptor to the private kernel protocol. The
  kernel performs the open, file-type/size check, strict decode, and publication;
  there is no second host read or host-side content cache.
- Managed loading never copies file bytes into the `rlm_eval` tool input, system
  prompt, host/kernel protocol frame, or generated tool result. User Python can
  still deliberately print or return `context`; that ordinary bounded cell output
  is visible in the official Session log and is outside this confidentiality claim.
- The same cell sees the new `context`; later cells in the same DSH Session
  reuse it. Different Sessions remain isolated.
- `context_meta` is a protected mapping with `kind`, canonical `path`, and
  UTF-8 `bytes`. The kernel restores both `context` and `context_meta` after
  each cell, just as it restores `rlm_query`, so user code cannot silently
  replace the managed source for a later cell.
- Loading is atomic. Validation and decoding complete before either protected
  global changes. A managed-context error leaves the live kernel and its prior
  managed context intact.
- The kernel rejects a non-regular source before opening it, opens with
  nonblocking/no-follow safeguards where available, and compares the opened
  descriptor identity before and after the read. A replacement or mutation race
  is a typed failure, never a partial publication or stale metadata record.
- Invalid path shape, missing/non-file targets, size overflow, invalid UTF-8,
  and read races are typed `context` errors. Cancel, hard timeout, protocol
  fault, or process failure retain the existing fatal namespace-loss rules.
- Private protocol version `2` is required. A host/kernel version mismatch
  fails explicitly; an old kernel must never ignore `contextPath` silently.

## Configuration

`maxContextBytes` defaults to `67_108_864` (64 MiB) and accepts integers from
`1_048_576` through `1_073_741_824` bytes. The bound applies to file bytes
before decoding. It is independent of stdout, result, query, and frame limits.

## Ownership and lifecycle

The DSH Session continues to own the kernel identity. The kernel owns the
loaded text and metadata for its lifetime. No duplicate host cache is added.
Kernel eviction, plugin unload, or process crash discards the managed context;
M3 does not promise recovery across restarts.

## Non-goals

- relative paths, globs, directories, URLs, or remote sources;
- automatic attachment resolution (the current official DSH attachment API is
  image-oriented and is not a stable text-source authority);
- chunking, summarization, embeddings, retrieval, watch/reload, or mmap;
- snapshot/restore within M3 itself or cross-host persistence (M5 later adds
  a narrowly bounded, private runtime checkpoint);
- a new model-facing tool or public service.

## Acceptance examples

1. RED then GREEN: a same-cell evaluation receives `contextPath` and returns a
   value derived from `context` without embedding file contents in the input or
   managed-loading protocol frame.
2. A later cell reuses the managed `context`; another Session cannot see it.
3. Replacing `context` or `context_meta` inside a cell does not alter the next
   cell's protected values.
4. Missing, relative, directory, oversized, and malformed UTF-8 sources return
   typed `context` errors while preserving the prior context and kernel PID.
5. Cancellation and timeout obey the existing fatal lifecycle contract.
6. A clean DSH Profile using `DeepSeek-V4-Flash-Vision-Exp` loads a large UTF-8
   fixture through `contextPath`, performs an `rlm_query`, and proves via the
   official Session log that the fixture contents were not copied into the
   model-facing tool argument or result by the loader itself.
