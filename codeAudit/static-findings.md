# Static findings

## SSE configuration is silently routed through Streamable HTTP

- Source: `.mcp.json` server entry with `type: "sse"` and an `Authorization` header.
- Chain: the parser accepts any URL entry but preserves only `streamable-http`; all other values become `http` -> the manager always creates `StreamableHTTPClientTransport` -> legacy SSE servers cannot complete the MCP handshake.
- Impact: valid static Bearer authentication appears broken even though the header itself is configured correctly.

## Static Authorization detection is case-sensitive

- Source: HTTP headers configured with a lowercase or mixed-case authorization name.
- Chain: OAuth selection checks only `headers.Authorization` -> a valid static credential can be mistaken for an OAuth configuration.
- Impact: incorrect authentication mode and misleading `needs-auth` state.

