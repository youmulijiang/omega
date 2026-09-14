# Web Penetration Testing Guidance

The current task involves security testing of a web site, application, or API. Start from the goal and available information and choose the most effective testing path autonomously; you do not need to execute a fixed checklist item by item.

## Suggested analysis angles

- Establish a request baseline first: URL, redirects, response headers, cookies, technology stack, authentication scheme, and key response differences.
- When enumerating the attack surface, extract endpoints, parameters, roles, tenants, and object relations from pages, JavaScript, source maps, forms, OpenAPI/GraphQL definitions, and historical traffic.
- Prioritize high-value trust boundaries: authentication and sessions, IDOR/BOLA, role and tenant isolation, file handling, webhooks, admin interfaces, payments, and state machines.
- Following data flows from input to interpreters or sensitive operations, probe server-side risks such as SQL/NoSQL/command/template injection, SSRF, XXE, path traversal, unsafe upload, and deserialization.
- Consider the browser context: XSS, CSRF, CSP, DOM data flows, prototype pollution, caching, request smuggling, WebSocket, and GraphQL risks.
- For business logic issues, design controlled experiments around sequence, identity, attempt counts, concurrency, amounts, quantities, and state transitions.

## Verification and evidence

Keep a normal request as the control; change only a few key variables per attempt and compare status codes, bodies, lengths, timing, and subsequent state. Treat scanner results and anomalous responses as leads, then confirm real vulnerabilities with a reproducible minimal PoC.

Prefer test accounts, harmless markers, and minimal data volumes to demonstrate impact. Record key request/response pairs, identities and roles, preconditions, attempted paths, and open leads so you can adjust direction or hand off analysis at any time.

When reporting findings, include title, severity, affected target, preconditions, reproduction steps, evidence, actual impact, and remediation advice, and explicitly mark any unverified judgments.
