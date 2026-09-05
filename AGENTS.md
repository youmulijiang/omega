# Development Rules

## Project

- This is a TypeScript monorepo. `packages/omega-core` extends `packages/coding-agent` through the Pi extension API.
- Omega modules register through `packages/omega-core/src/entry.ts`; the CLI injects that extension from `cli-runner.ts`.
- Run source with `./pi-test.sh` on Unix or `./pi-test.ps1` on Windows. Both must start the Omega CLI.
- Security testing targets are authorized lab environments.

## Communication

- Be concise, direct, and technical. Avoid filler and emojis in code or repository communication.
- Answer questions before editing. For feedback or review, state agreement or disagreement first.
- Explain non-trivial work as: problem, concrete example or trace, then necessary solution.

## Code

- Read a file fully before broad edits, investigations, or audits.
- Prefer simple, typed code. Avoid `any`; inspect dependency types in `node_modules` instead of guessing.
- Use top-level imports only. Relative TypeScript imports must include `.ts`; do not use inline or dynamic imports.
- Code covered by the root TypeScript config must use erasable syntax: no parameter properties, `enum`, `namespace`, `module`, `import =`, or `export =`.
- Inline trivial one-use helpers.
- Ask before removing intentional functionality. Do not add compatibility layers unless requested.
- Upgrade outdated dependencies when their types are wrong; do not remove or weaken code to satisfy them.
- Put configurable keybindings in `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`; never hardcode key checks.
- Do not edit `packages/ai/src/models.generated.ts` directly. Update its generator and regenerate it.
- Register Omega functionality in `omega-core`, then include its registrar in `src/entry.ts`. Pi kernel changes require a capability unavailable through `ExtensionAPI`.

## Validation

- After code changes, run `npm run check` with full output and resolve all findings. Documentation-only changes do not require it.
- Do not run `npm run build`, `npm test`, or the full Vitest suite unless requested; environment variables can activate e2e tests.
- Run changed tests directly from their package:
  - Vitest: `node <repo>/node_modules/vitest/dist/cli.js --run <test-file>`
  - `packages/tui`: `node --test <test-file>`
- Run all non-e2e tests only through root `./test.sh`.
- A modified test must pass before completion.
- Coding-agent suite tests use `test/suite/harness.ts` and the faux provider. Never use real providers, keys, or paid tokens.
- Put issue regressions in `packages/coding-agent/test/suite/regressions/<issue>-<slug>.test.ts`.
- Put ad-hoc scripts in a temporary file and remove it afterward.
- For interactive smoke tests, start `pi-test.sh` in tmux, send input, capture output, then kill the session. On Windows, use `pi-test.ps1` and RPC `get_commands` when command registration is under test.
- Never commit unless requested.

## Dependencies

- Pin direct external dependencies to exact versions. Review dependency and lockfile changes as code.
- Use `npm install --ignore-scripts` for local hydration, `npm ci --ignore-scripts` for clean installs, and `npm install --package-lock-only --ignore-scripts` after dependency metadata changes.
- Do not run lifecycle scripts unless requested.
- Before updating `undici`, read the target release notes and assess compatibility.
- Regenerate coding-agent shrinkwrap with `node scripts/generate-coding-agent-shrinkwrap.mjs`; lifecycle dependencies need review and an explicit allowlist entry.
- Set `PI_ALLOW_LOCKFILE_CHANGE=1` only when the user wants lockfile changes committed.

## Git

- Other sessions may share this worktree. Touch only files owned by the current task and preserve unrelated staged, unstaged, and untracked changes.
- Stage explicit paths only. Before committing, verify `git status` and the staged diff.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`, or force-push.
- Resolve rebase conflicts only in files changed by this task. Abort and ask if another file conflicts.
- Commit format: `{feat,fix,docs}[(ai,tui,agent,coding-agent,omega-core)]: <summary>`.
- Include `fixes #N` or `closes #N` for each issue that the commit should close.

## Issues and PRs

- Follow `CONTRIBUTING.md` contributor gates.
- Review PRs without switching the worktree: use `gh pr view`, `gh pr diff`, `gh api`, `git show`, or fetched refs.
- Apply all relevant existing `pkg:*` labels.
- Post multiline comments with a temporary file and `--body-file`. Keep them concise and include the disclaimer required by the originating prompt.

## Changelog

- Edit only `## [Unreleased]` in `packages/*/CHANGELOG.md`; never change released sections or duplicate subsections.
- Use `Breaking Changes`, `Added`, `Changed`, `Fixed`, or `Removed` as appropriate.
- Add entries only on `main` or a pull-request branch.
- Attribute issues as `([#N](issue-url))`; external PRs also include the contributor.

## Release

- Packages use lockstep versions. Additions and fixes use `patch`; breaking changes use `minor`; do not create major releases.
- Before release, confirm `/cl` audited the latest `main` commit and all `[Unreleased]` sections.
- Run `npm run release:local -- --out /tmp/pi-local-release --force`, then smoke-test Node and Bun binaries outside the repository: help, version, model listing, interactive startup, and one real prompt.
- Release with `PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch` or `release:minor`. Review generated lockfile and shrinkwrap changes.
- The release script commits, tags, and pushes. Never rerun it after the tag is pushed.
- CI publishes through npm trusted publishing and updates the R2 release marker. If CI fails, fix or rerun the failed job; do not create the same version again.

## Overrides

- If a user request conflicts with these rules, explain the conflict and obtain explicit confirmation before overriding it.
