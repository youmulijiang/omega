# MCP authentication audit report

## Summary

- Confirmed defects: 2
- Fixed: 2
- Highest impact: authenticated legacy SSE MCP servers were routed through the wrong transport and could not connect.

## Fixes

- Preserve `type: "sse"` during configuration parsing and construct `SSEClientTransport`.
- Supply configured headers to both the SSE receive connection and its POST requests.
- Detect static Authorization headers case-insensitively and do not misclassify their failures as OAuth challenges.

## Verification

- Focused MCP tests: 19 passed.
- Authorized local Burp MCP: connected; initialization and tool discovery succeeded.
