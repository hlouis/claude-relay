---
name: playwright-e2e
description: End-to-end browser testing for the clay daemon using Playwright against a fully-isolated daemon instance. Use when verifying UI features that require a running daemon (file browser, HTML preview, session UI, project switcher, multi-user flows) and the verification benefits from a clean state that cannot pollute the user's real ~/.clay. Spins up an isolated daemon via `npm run dev:isolated`, drives it with Playwright in headless Chromium, and tears everything down. Use this skill instead of writing one-off Playwright scripts when the user asks to "test in the browser", "run an e2e check", or "verify the UI behavior" of a clay feature.
---

# Playwright E2E against an isolated clay daemon

## When to use

- A UI feature needs end-to-end verification (file browser, preview, session UI, etc.).
- The verification must not touch the user's real `~/.clay` or recent-projects list.
- A reproducible browser-driven check is more reliable than asking the user to click around.

## Lifecycle (always do these in order)

1. **Pick paths** — `<HOME>` and `<PROJECT>` under `os.tmpdir()` (e.g. `/tmp/clay-e2e-<feature>-home`, `/tmp/clay-e2e-<feature>-project`). Use a feature-specific suffix so parallel runs don't collide.
2. **Drop fixtures** into `<PROJECT>` (HTML/JS/etc. the test reads). See `assets/fixtures/` for ready-made samples.
3. **Start the daemon** via the project's npm script. This is the ONLY supported way to launch — do not hand-roll `node bin/cli.js`:
   ```bash
   npm run dev:isolated -- start --home <HOME> --project <PROJECT> --port <PORT> --pin 123456
   ```
   Defaults: port 12700, pin 123456, host 127.0.0.1, no https, skip-permissions. The daemon registers `<PROJECT>` as its only project (slug = directory basename).
4. **Run the Playwright script** — see `scripts/run-e2e.template.mjs` for a copy-able runner. Always `--no-https` so the URL is `http://127.0.0.1:<PORT>/p/<slug>/`.
5. **Stop and wipe** — even on test failure:
   ```bash
   npm run dev:isolated -- wipe --home <HOME>
   rm -rf <PROJECT>
   ```

## Critical isolation rule

`os.homedir()` reads `$HOME`, and `~/.clayrc` (recent projects) lives under it. The npm script overrides both `HOME` and `CLAY_HOME` to the isolated dir. **Never run the CLI with only `CLAY_HOME` set** — recent projects would leak from the real `~/.clayrc`. The script also sets `cwd` to `<PROJECT>` because the daemon auto-registers `cwd` on startup; without this, your real shell directory becomes a stray project.

## Finding Playwright

The project does not depend on Playwright. Locate an existing install on the user's machine:

```bash
find ~/.npm/_npx ~/Develop -maxdepth 6 -name "playwright" -type d -path "*/node_modules/*" 2>/dev/null | head -3
```

Pick one and import via absolute path: `import { chromium } from "/abs/path/playwright/index.mjs"`. Verify Chromium is downloaded under `~/Library/Caches/ms-playwright/` (macOS) or `~/.cache/ms-playwright/` (Linux). If missing, `npx playwright install chromium`.

## Driving the file browser

These DOM hooks are stable. See `references/selectors.md` for the full map.

- Tree rows: `.file-tree-item[data-path="<rel/path>"]` — click parent dirs first to expand, then click the leaf.
- Render toggle (markdown / HTML preview): `#file-viewer-render`.
- Active preview iframe: `.file-viewer-html-preview`. Read content with `page.frameLocator(".file-viewer-html-preview").locator(...)`.

## Page-load gotchas

- Use `await page.goto(url, { waitUntil: "domcontentloaded" })` then `page.waitForTimeout(2000)`. The default `load` event can hang on long-poll connections.
- The single-user `--dangerously-skip-permissions` flow auto-authenticates; **do not** try to fill a PIN input on first load — there isn't one in this isolated config.
- Don't trust `networkidle` — the app keeps a WebSocket open.

## Verifying without screenshots

Don't rely on `page.screenshot()` for headless assertions — it can hang on font loading for certain pages (e.g. SVG documents). Assert on DOM text instead:

```js
var h1 = await page.frameLocator(".file-viewer-html-preview").locator("h1").textContent({ timeout: 3000 });
```

Take screenshots only for human debugging, with a low timeout and a try/catch.

## Bundled resources

- `scripts/run-e2e.template.mjs` — full lifecycle template (start daemon → fixtures → tests → wipe). Copy and adapt.
- `scripts/lifecycle.mjs` — small helpers (`startDaemon`, `stopDaemon`, `wipeDaemon`) callable from any test script.
- `assets/fixtures/` — copy-able sample HTML for the preview feature: `static.html`, `spa.html`, `report.html`, `evil.html`, `evil.svg`. Each has a docstring describing what behavior it tests.
- `references/selectors.md` — known DOM hooks across the UI (file browser, viewer, modals, project switcher).

## Workflow

1. Read `references/selectors.md` for the DOM hooks the target feature uses.
2. Copy `scripts/run-e2e.template.mjs` into the test project dir or `/tmp/`.
3. Customize the test cases.
4. Run it: `node /tmp/run-e2e.mjs`. The template handles start + wipe automatically.
5. Report pass/fail counts. If any test fails, screenshots land in the output dir for inspection.
