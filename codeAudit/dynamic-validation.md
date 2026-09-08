# Dynamic validation

## Target setup

- Target: `http://127.0.0.1:9876/`
- Transport: SSE
- Credential: static Bearer token (redacted)

## Initial result

- Verdict: target reachable and static Bearer credential accepted.
- Evidence: authenticated `GET /` with `Accept: text/event-stream` returned `HTTP/1.1 200 OK` and `Content-Type: text/event-stream`.
- The stream remained open as expected and the bounded probe timed out after three seconds.

## Post-fix result

- Verdict: true positive, fixed.
- Omega preserved `type: "sse"`, connected successfully with the static Bearer header, completed MCP initialization, and retrieved the Burp tool list.
- Credential values are intentionally omitted.
