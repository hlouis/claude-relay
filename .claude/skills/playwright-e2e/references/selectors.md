# DOM selector map

Verified against the codebase at the time of skill creation. If a selector breaks, grep `lib/public/modules/` and `lib/public/css/` for the class name and update this file.

## URL shape

`http://127.0.0.1:<PORT>/p/<slug>/` — slug equals the basename of the registered project directory. Trailing slash matters: relative URLs in client code resolve against it.

## File browser (left side panel)

| Element | Selector | Notes |
|---|---|---|
| Tool tile (opens panel) | `text=File browser` or `.tool-card:has-text("File browser")` | Triggered by clicking the tile in the project's TOOLS section. |
| File tree row | `.file-tree-item[data-path="<rel>"]` | `<rel>` is path relative to project root. Clicking a dir toggles expansion; clicking a file opens it. |
| Search input | `input[placeholder="Search files..."]` | |

To open a nested file: click each ancestor dir to expand, then click the leaf. Add small `waitForTimeout(300)` between clicks for the tree to refresh.

## File viewer (right pane, opens after clicking a file)

| Element | Selector | Notes |
|---|---|---|
| Title | `#file-viewer-path` | Shows the current file path. |
| Body container | `#file-viewer-body` | Holds source code, markdown preview, or HTML iframe. |
| Render/preview toggle | `#file-viewer-render` | Visible for `.md`, `.mdx`, `.html`, `.htm`. Toggles raw source ↔ rendered view. |
| Copy button | `#file-viewer-copy` | |
| PDF export button | `#file-viewer-pdf` | Markdown only. |
| Close button | `#file-viewer-close` | Or press `Escape`. |
| HTML preview iframe | `.file-viewer-html-preview` | Only present in rendered mode for HTML files. Read content with `page.frameLocator(".file-viewer-html-preview")`. |
| Markdown body | `.file-viewer-markdown` | Rendered markdown container. |

## Sidebar / project switcher

| Element | Selector | Notes |
|---|---|---|
| Project dropdown trigger | The top-left text matching the current project slug | E.g. `text=clay-test-project` — wraps a `<button>` ancestor. |
| Command palette | Cmd/Ctrl+K | Opens global search; can switch projects from here. |

## Auth (only relevant outside `--dangerously-skip-permissions`)

| Element | Selector | Notes |
|---|---|---|
| PIN input | `#us-pin-current-input` | 6-digit numeric. Submit with Enter. |

The isolated daemon launched by `npm run dev:isolated` uses skip-permissions, so this input is hidden — don't wait for it.

## Verifying response headers in-test

Use `page.request.get(url)` (not `fetch`) so cookies and base URL are inherited from the browser context:

```js
var resp = await page.request.get(PROJECT_URL + "api/file-preview/site/index.html");
console.log(resp.status(), resp.headers()["content-security-policy"]);
```
