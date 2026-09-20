# Background tools

`bg_run` starts a named shell command and returns its task ID immediately. Set
`isAgent: true` only when the command launches an LLM or agent process; use
`false` for tests, scripts, servers and other ordinary commands. By default a
terminal notification starts a follow-up agent turn. Do not poll `bg_status` or
`bg_logs` merely to wait; use `bg_logs` when output is actually needed.

`bg_delegate` starts a separate inspect-only Pi agent. Its `prompt` is the
authoritative task, and the child receives a projection of the current
conversation. Parent tool output is omitted, so restate any needed findings in
the prompt. After the terminal notification, call `bg_result` once for the
verified answer. The delegate cannot run shell commands, write files, use the
network or delegate further.

Advanced `bg_delegate` options:

- `extensionMode`: `isolated` by default. `ambient` enables discovered
  extensions for extension-registered providers; those extensions execute code
  in the child process and are not sandboxed by its tool allowlist.
- `notifyOnCompletion` and `triggerOnCompletion`: both default to `true`.
  Disabling the former also makes automatic follow-up impossible. Disable
  either only when deliberately taking over completion monitoring.
- `maxTurns`, `maxToolCalls` and `timeoutSeconds`: optional child limits.

`bg_result` returns a verified inline answer when it fits the inline limit;
larger answers are returned as an artifact reference without truncation.
Delegate completion notifications carry task state, not the answer. The
internal auto-delivery setting is fixed to `never`; use `bg_result` to retrieve
the answer.
