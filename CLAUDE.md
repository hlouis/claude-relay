# CLAUDE.md

Top-level guidance for the **claude-relay** monorepo. For subproject-specific
rules, see [`daemon/CLAUDE.md`](daemon/CLAUDE.md) and
[`apple/CLAUDE.md`](apple/CLAUDE.md) — they take precedence over this file
within their respective trees.

## Project Overview

claude-relay merges two previously-separate projects into a single repo:

- **Clay daemon** (`daemon/`) — Node.js HTTP/WebSocket server that drives the
  Claude Agent SDK. Published as `@hlouis/clay` on npm. Ships with a bundled
  browser frontend.
- **Clarc** (`apple/`) — Apple-platform native client. Currently macOS only;
  iOS and iPadOS targets are the next milestone.

**Goal:** Clarc becomes a thin native client of the Clay daemon. The two
communicate over **WebSocket** using the contract defined in `protocol/`.
All three Apple platforms (macOS, iOS, iPadOS) share that same protocol.

The daemon's existing browser UI and the new native clients are peers — both
are first-class consumers of the WebSocket protocol.

## Layout

| Path        | Role                                                         |
|-------------|--------------------------------------------------------------|
| `daemon/`   | Clay daemon (Node.js). Has its own `CLAUDE.md`.              |
| `apple/`    | Clarc + future iOS/iPadOS targets (Swift). Has its own `CLAUDE.md`. |
| `protocol/` | Single source of truth for the daemon ↔ client WebSocket contract. |
| `justfile`  | Top-level task runner. Run `just` to list commands.          |

## Working in this repo

- Use `just <task>` from the repo root for cross-cutting commands
  (`daemon-dev`, `mac-build`, etc.). Subproject-specific commands still live
  inside each subdirectory.
- **Protocol changes are cross-cutting.** Any edit under `protocol/` must be
  reflected on both the daemon side and every Apple target. Treat `protocol/`
  as the contract; don't drift.
- Never push `apple/` history back to the old `ttnear/Clarc` repo. Subtree
  history is preserved here for `git blame`, but this monorepo is now
  authoritative.

## Language conventions

- **Committed text** (code, comments, commit messages, PR descriptions, log
  output) — **English only**, regardless of subproject.
- **Chat with the user** — Chinese.
- The "Korean chat" rule that lives in older Clarc docs is obsolete; ignore it.

## Commit & PR rules (apply repo-wide)

- **Never commit, push, open PRs, or comment on issues automatically.** Only
  do these when explicitly asked.
- **Never add `Co-Authored-By` or "Generated with Claude Code" lines** to
  commit messages.
- Use **Conventional Commits**: `type(scope): description`.
  - `type` is English (`feat`, `fix`, `refactor`, `chore`, `docs`, `perf`,
    `test`, `build`, `ci`, `style`).
  - `scope` should identify the area, e.g. `daemon`, `apple`, `protocol`,
    `repo` for monorepo-level changes.
  - For daemon-only commits, follow `daemon/CLAUDE.md` (Angular convention,
    use the `angular-commit` skill).
- If you find unrelated changes while preparing a commit, **stop and ask** —
  don't silently revert them to make the diff "clean".

## When subproject rules conflict with this file

Subproject `CLAUDE.md` wins inside its own tree. This file only governs
work that spans subprojects or sits at the repo root (`protocol/`,
`justfile`, top-level docs, CI configs in `.github/`).
