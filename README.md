# claude-relay

Run Claude Code on one machine, drive it from anywhere.

A daemon (`@hlouis/clay`) wraps the Claude Agent SDK and exposes it over WebSocket. Clients — a bundled web UI, the macOS app Clarc, and a planned iOS app — connect to the daemon to drive Claude remotely.

## Layout

| Path | Contents |
|------|----------|
| [`daemon/`](daemon/) | Clay daemon — Node.js WS + HTTP server with bundled web UI. Published as [`@hlouis/clay`](https://www.npmjs.com/package/@hlouis/clay). |
| [`apple/`](apple/) | Clarc — native client for macOS, iOS planned. Xcode workspace + Swift Packages. |
| [`protocol/`](protocol/) | Shared WebSocket protocol contract between daemon and clients. |

## Use

On a host with `claude` installed:

```bash
npx @hlouis/clay
```

Open the URL it prints and set a PIN.

**macOS app:** download the latest DMG from [Releases](https://github.com/hlouis/claude-relay/releases). Sparkle handles auto-update.

## Develop

Requires Node ≥ 20 and Xcode ≥ 16 (for the Apple side).

```bash
# Daemon — dev server on http://localhost:2635
cd daemon && npm install && npm run dev

# Apple
open apple/Clarc.xcodeproj
```

The top-level [`justfile`](justfile) wraps common tasks (`just daemon-dev`, `just mac-build`, …). Install with `brew install just`.

Protocol changes touch both sides — keep daemon and client updates in the same PR.

## Releases

- **Daemon** — semantic-release pipeline (currently paused during the v2 monorepo restructure).
- **macOS** — `apple/scripts/release.sh` produces a signed DMG and updates the Sparkle appcast.

## History

The macOS client originated at [ttnear/Clarc](https://github.com/ttnear/Clarc) and was merged into this repo via `git subtree`. `git blame apple/...` traces back to the original Clarc commits.

The pre-monorepo, daemon-only state is preserved on the [`main`](https://github.com/hlouis/claude-relay/tree/main) branch.

## License

MIT — see [LICENSE](LICENSE).
