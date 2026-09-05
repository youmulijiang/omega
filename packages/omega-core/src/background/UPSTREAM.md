# Upstream provenance

This directory is adapted from `ismailsaleekh/pi-background-tasks` version 2.5.0,
commit `14aa4ef382952f073bd4d540f57d6e8e3c2789a2`.

Upstream: https://github.com/ismailsaleekh/pi-background-tasks

The upstream ISC license is retained in `LICENSE`. The upstream third-party
notice is retained in `THIRD_PARTY_NOTICES.md`.

Omega adaptations:

- relative TypeScript imports use `.ts` for the repository's Node strip-only
  source convention;
- `registerBackground(omega)` integrates the extension with Omega's wrapped Pi
  extension API and registers the upstream Anthropic attribution transport;
- child extension entrypoints live under `background/extensions` and are
  resolved from the vendored core;
- the package build copies the delegate evidence JSON into `dist`;
- dependencies are owned by `@omega/core` instead of an independent package.
- runtime task artifacts are stored under `.omega/tasks` instead of `.pi/tasks`;
- the standalone package update checker and `/bg-update` command are omitted.

Protocol/schema identifiers retain their `pi-background-tasks` names for
compatibility with artifacts and EventBus clients produced by upstream 2.5.0.
