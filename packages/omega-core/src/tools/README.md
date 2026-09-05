# Shared tools

`registerTools(omega)` registers `http_request`, `http_replay`, and `diff` from the
Omega extension entry. Modules can import the functions and types from
`./tools/index.ts`, or import `http.ts` / `diff.ts` directly without loading the
tool registration adapter. No additional dependencies are required.

## HTTP request

```ts
import { requestHttp, replayHttp, diffText } from "./tools/index.ts";

const response = await requestHttp({
  url: "http://127.0.0.1:8080/api/items?limit=1",
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: '{"name":"example"}',
}, signal);
```

The model tool uses the same fields. Defaults: `GET`, UTF-8 input/output, 30,000 ms
total timeout, 262,144 response bytes. `timeoutMs` accepts 1–300,000 and
`maxResponseBytes` accepts 1–10,485,760. Request bodies are limited to 10 MiB.
Use `bodyEncoding: "base64"` and `responseEncoding: "base64"` for binary data.

Results include status, status text, an ordered array of response headers
(including repeated headers), body, encoding, retained byte count, truncation
flag, and total duration. HTTP 4xx/5xx are valid responses. Connection, parsing,
timeout and cancellation failures throw errors. Bytes beyond the response limit
are discarded and the response connection is closed.

Requests use HTTP/1.1 over HTTP or HTTPS with certificate verification. There is
no automatic redirect, retry, cookie persistence, proxy support or content
decompression. `Accept-Encoding` defaults to `identity`. For servers that still
return compressed content, select Base64 to retain the compressed bytes.
Protocol upgrades and CONNECT tunnels are unsupported. Content-Length is
recalculated; Transfer-Encoding input is rejected. An explicit Host header is
supported. Model calls pass through Omega's existing permission hooks; direct
module callers are responsible for their execution policy.

## HTTP replay

```ts
const replay = await replayHttp({
  url: "http://127.0.0.1:8080/api/items/1",
  rawRequest: "GET /api/items/1 HTTP/1.1\r\nHost: captured.example\r\nAuthorization: Bearer old\r\n\r\n",
  headers: { Authorization: "Bearer replacement" },
}, signal);

const difference = diffText(response.body, replay.body);
```

`http_replay` takes `rawRequest` plus the HTTP request fields. The explicit full
`url` replaces the captured target path, query and Host. The captured method and
body are used unless overridden. Header overrides are case-insensitive. Duplicate
captured headers are retained; Host and Content-Length are regenerated (Host can
be explicitly overridden). CRLF and LF header separators are accepted. The
captured body is UTF-8; binary body overrides can use Base64.

This is semantic replay, not byte-exact packet replay. Folded headers, chunked
captures and non-HTTP/1.x request lines are rejected. Requests are stateless;
replay does not use a stored request ID.

## Text diff

The model tool accepts `{ "before": "old\n", "after": "new\n" }`.
`diffText(before, after)` returns equality, added/removed line counts and change
blocks containing `type`, exact `text`, one-based `oldLine` / `newLine`, and
`lineCount`. Concatenating all non-added blocks reconstructs `before`;
concatenating all non-removed blocks reconstructs `after`.

Comparison preserves whitespace, CRLF/LF differences, Unicode and the final
newline. Each input is limited to 1 MiB. After removing a common prefix/suffix,
comparisons requiring more than four million table cells replace the differing
middle and set `coarse: true`; the result remains exact but may not be minimal.
`formatTextDiff` displays changed lines with `+`/`-`, renders carriage returns as
`\r`, and marks missing final newlines. The 24,000-character preview is a display
format, not an apply-ready patch; complete blocks are returned in tool details.
