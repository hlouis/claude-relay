# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Rules

- Never add `Co-Authored-By` lines to git commit messages.
- Use `var` instead of `const`/`let`. No arrow functions.
- Server-side: CommonJS (`require`). Client-side: ES modules (`import`).
- Never commit, create PRs, merge, or comment on issues automatically. Only do these when explicitly asked.
- All user-facing messages, code comments, and commit messages must be in English only.
- Commit messages must follow Angular Commit Convention (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `perf:`, `test:`, `style:`, `ci:`, `build:`). Use `!` or `BREAKING CHANGE:` footer for breaking changes. Always use the `angular-commit` skill when committing.
- Never use browser-native `alert()`, `confirm()`, or `prompt()`. Always use custom JS dialogs/modals instead.

## Project Overview

Clay (npm: `clay-server`, legacy name: `claude-relay`) is a local relay server that provides a web UI for Claude Code. It drives Claude Code via the Claude Agent SDK and streams data to the browser over WebSocket. Not a CLI wrapper — it uses the SDK's async iterable interface directly.

## Development Commands

```bash
# Run in development mode (foreground, auto-restart on lib/ changes, port 2635)
npm run dev
# or equivalently:
node bin/cli.js --dev

# Run production mode
node bin/cli.js

# Useful CLI flags for development
node bin/cli.js --debug          # Enable debug panel
node bin/cli.js --no-https       # Skip HTTPS/cert setup
node bin/cli.js --no-update      # Skip update check
```

No build step, no transpilation, no test framework. Pure Node.js (requires Node 20+). The code ships as-is from `bin/` and `lib/`.

## Architecture

### Daemon Model
CLI (`bin/cli.js`) spawns a background daemon (`lib/daemon.js`) with `detached: true`. Multiple CLI instances connect to a single daemon via Unix Domain Socket IPC (`~/.clay/daemon.sock`). The daemon runs an HTTP/WS server on a single port.

### Key Server-Side Files (`lib/`)
- **`daemon.js`** — Background daemon process, manages all projects and the HTTP/WS server lifecycle
- **`server.js`** — HTTP server, WebSocket handling, static file serving, slug-based routing
- **`project.js`** — Per-project context: owns the Claude Agent SDK session, message queue, permission flow, session persistence
- **`sdk-bridge.js`** — Bridge between the project's message queue and the Claude Agent SDK async iterable interface
- **`sessions.js`** — JSONL append-only session storage at `~/.clay/sessions/{encoded-cwd}/{cliSessionId}.jsonl`
- **`config.js`** — Config management, daemon.json, socket paths, slug generation
- **`ipc.js`** — Line-delimited JSON IPC over Unix Domain Socket
- **`push.js`** — Web Push notification service (requires HTTPS via mkcert)
- **`terminal.js` / `terminal-manager.js`** — PTY-based terminal sessions via `@lydell/node-pty`
- **`pages.js`** — HTML page generation (dashboard, project UI)

### Frontend (`lib/public/`)
Vanilla JS, no framework, no bundler. Single-page app served as static files.
- **`app.js`** — Main entry point, WebSocket connection, message routing
- **`modules/`** — Feature modules (sidebar, input, tools, filebrowser, terminal, rewind, notifications, theme, markdown, diff, etc.)
- **`css/`** — Modular CSS files per feature
- **`sw.js`** — Service worker for PWA push notifications

### Routing Pattern
```
/                    → Dashboard
/p/{slug}/           → Project UI
/p/{slug}/ws         → WebSocket
/p/{slug}/api/...    → Project REST API
```

### Permission Flow
SDK calls `canUseTool()` → server creates a Promise stored in `pendingPermissions[requestId]` → broadcasts `permission_request` to all WS clients + sends push notification → client responds with `permission_response` → Promise resolves → SDK continues.

## Local Patches

See `LOCALCHANGES.md` for local modifications on top of upstream. After syncing upstream, re-apply patches as needed. The file documents each patch's purpose and exact implementation requirements.

## Design System

See `DESIGN.md` for Clay's color system and accent rules. Key rules:
- All colors via CSS custom properties (`var(--xxx)`), never hardcoded (except selection highlight)
- Two accents: `--accent` (terracotta, base09) for interactions, `--accent2` (indigo) for info/status only
- Theme files named `clay-*.json`, not `claude-*`
- Favicon is the design reference — when in doubt, compare against it

## Contributing Conventions

- Bug fixes and typos welcome; feature PRs not accepted (open an issue instead)
- Keep PRs small and focused, one change per PR
- Follow existing code style (vanilla JS, no build tools, no new dependencies without discussion)
