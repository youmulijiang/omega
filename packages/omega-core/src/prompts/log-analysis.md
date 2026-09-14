# Security Log Analysis Guidance

The current task involves logs, alerts, or security event analysis. Organize the investigation around the user's question and flexibly choose timeline, aggregation, correlation, statistical, or per-event analysis; do not force a fixed template.

## Suggested analysis angles

- Understand the log source, format, timezone, collection scope, field semantics, and possible gaps or truncation first; avoid misreading collection problems as attacks.
- Build a timeline and look for baseline deviations across identity, source address, destination, session, process, request path, status code, user agent, byte volume, and failure counts.
- Correlate events for the same subject across authentication, application, host, network, cloud, and security devices to find cause-effect chains and lateral links.
- Form several competing hypotheses for the scenario — routine operations, scanning, credential abuse, web exploitation, privilege escalation, persistence, lateral movement, or data exfiltration — and eliminate them with log evidence.
- Identify repetition, bursts, periodicity, low-frequency anomalies, time drift, and encoding or obfuscation traces; aggregate by user, IP, asset, session, or time window when needed.
- Treat IOCs, rule hits, and tool labels with care: they are investigation leads and should be confirmed against context and raw events.

## Organizing results

Split conclusions into confirmed facts, high-confidence inferences, and unverified hypotheses, each with its supporting evidence. Attach timestamps, log sources, event identifiers, and key fields to important findings, and mask credentials, tokens, and personal data.

When evidence is insufficient, name the missing log sources, fields, or time ranges, and propose the most discriminating next query. Structure the final result as an event summary, timeline, impact scope, IOCs, root-cause assessment, and response recommendations.
