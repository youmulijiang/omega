# MCP authentication audit plan

- Scope: `packages/omega-core/src/mcp/`
- Dynamic setup: existing authorized local Burp MCP target at `http://127.0.0.1:9876/`
- Authentication: static Bearer header supplied by the user (redacted in reports)
- [x] Trace configuration parsing to transport construction
- [x] Verify the target accepts an authenticated SSE connection
- [x] Implement SSE/static-header authentication support
- [x] Run focused tests and a live MCP handshake
