# claude-relay

Monorepo for the Clay daemon and its native Apple clients.

## Layout

| Path | Contents |
|------|----------|
| [`daemon/`](daemon/) | Clay daemon — Node.js HTTP/WebSocket server, published as [`@hlouis/clay`](https://www.npmjs.com/package/@hlouis/clay) on npm. Includes the bundled browser frontend. |
| [`apple/`](apple/) | Apple platform clients (Clarc for macOS, iOS target planned). Xcode workspace + Swift Packages. |
| `protocol/` | Shared WebSocket protocol artifacts. Single source of truth as the daemon ↔ client contract evolves. |

## Quick start

```bash
# Daemon
cd daemon && npm install && npm run dev

# Apple
open apple/Clarc.xcodeproj
```

## Repository history

The macOS client previously lived at [ttnear/Clarc](https://github.com/ttnear/Clarc) and was merged into this repo via `git subtree`. Pre-merge history is preserved — `git blame apple/...` traces back to the original Clarc commits.

## Releases

- **Daemon**: `@hlouis/clay` on npm, automated via semantic-release on push to `main` (beta) / `release` (stable).
- **Apple (macOS)**: signed DMG + Sparkle appcast, built locally via `apple/scripts/release.sh`.

See each subproject's README and CHANGELOG for details.

## License

MIT — see [LICENSE](LICENSE).
