# Main 重建后的本地功能计划

## 当前状态

- `main` 已经用 `upstream/main` 的内容重建到 `da3978d`（`v2.38.0-beta.6`）。
- 本地 `main` 追踪的是 `origin/main`，所以最终 push 目标仍然是 Louis 自己的 fork。
- 旧的 `main` 已备份为 `backup/main-before-upstream-sync-20260509`，对应提交是 `703f9ac`。
- 本地 `origin/HEAD` 已指向 `origin/main`。
- 必须项已按确认结果重新实现：`@hlouis/clay` 发布身份、`clay` CLI 命令，以及带动态 tab 的 `@` 文件/mate/user 补全菜单。

## 必须重新实现的本地功能

### 1. Louis 自己的 npm 包名和发布目标

目标：保留 upstream 的最新代码和依赖，但发布时使用 Louis 自己的包名、仓库和发布身份。

建议修改：

- 更新 `package.json`：
  - `name`
  - `repository`
  - `bugs`
  - `homepage`
  - `author`
  - `publishConfig`
- 更新 `release.config.js`：
  - `repositoryUrl`
  - release 评论或提示里的 npm 更新命令
- 更新 CLI 和 updater 里展示给用户的包命令：
  - 把 upstream 的 `npx clay-server` 提示替换为 fork 自己的包命令。
  - 默认保留 upstream 新的 bin 结构，除非确认需要删除兼容别名。
- 保留 upstream 的新依赖版本，尤其是：
  - `@anthropic-ai/claude-agent-sdk`
  - `@openai/codex`
  - YOKE 相关代码

已确认：

- npm 包名继续使用旧 `main` 的 `@hlouis/clay`。
- CLI 命令名继续暴露为 `clay`。
- 保留 upstream 的 `claude-relay` 兼容 bin。

### 2. 使用 `@` 触发文件系统补全

目标：在主输入框中输入 `@` 时，补全当前项目里的文件路径。

旧实现：

- 直接在 `lib/public/modules/input.js` 中加入补全状态和 UI。
- `fs_list` 请求带上 `source: "at-complete"`。
- 把 `fs_list_result` 路由回输入框补全逻辑。

新的 upstream 架构：

- `@` 当前已经用于 mate/user mention，逻辑在 `lib/public/modules/mention.js`。
- 主输入框逻辑在 `lib/public/modules/input.js`。
- WebSocket 消息路由在 `lib/public/modules/app-messages.js`。
- 文件系统消息处理在 `lib/project-filesystem.js`。

建议实现方式：

- 新增独立 client 模块，例如 `lib/public/modules/input-file-complete.js`。
- 复用现有 `fs_list` 消息，并带上 `source: "at-complete"`。
- 在 `app-messages.js` 中按 `source: "at-complete"` 路由 `fs_list_result`。
- 在 `lib/public/css/input.css` 中加入作用域明确的样式。
- server 侧保持最小改动。`project-filesystem.js` 可能只需要在 `fs_list_result` 中原样带回 `source`。

已确认：

- 一个 `@` 菜单里同时支持 files、mates 和 users。
- 菜单顶部显示动态 tab：只有对应类别有数据时才显示 tab。
- file tab 默认选中。

## 可以考虑重新实现的候选功能

### 移动端和键盘输入细节

旧 `main` 有几组移动端输入修复：

- 触屏设备发送后 blur 输入框。
- 虚拟键盘打开时隐藏移动端 tab bar，并减少输入区底部 padding。
- iPadOS 外接键盘场景下，Enter 发送消息，而不是插入换行。
- IME 组合输入期间避免 Enter 误提交。

upstream 已经包含部分相关行为：

- 已有 `body.keyboard-open` 的 padding 处理。
- `input.js` 中已有 IME composition 状态。
- 当前移动端触屏设备按 Enter 会提前返回，不发送。

建议：

- 先只考虑重新实现 iPadOS 外接键盘行为。
- 发送后 focus/blur 和移动端 padding 行为先手动验证，再决定是否修改。

### Shift+Tab 切换 permission mode

旧 `main` 支持用 Shift+Tab 循环切换 permission mode。

建议：

- 只有在当前 upstream 的 permission mode UI 仍有清晰的 client-side 切换 API 时才重写。
- 放在 `input.js` 或对应设置/控制模块里，不要写回 `app.js` 的内联逻辑。

### Mac-only Cmd+F 行为

旧 `main` 调整过 Mac 上 Cmd+F 的行为。

建议：

- 先对照 upstream 现在的 command palette 和 session search 行为重新评估。
- 这是小 UX 优化，不属于第一轮重建必须项。

### 增量历史重连和 client message 去重

旧 `main` 增加过：

- 基于 `lastSeq` 的增量历史重连。
- 基于 `clientMsgId` 的乐观消息去重。
- `tab_visible` 未读同步。

upstream 的历史和渲染管线已经大幅变化。

建议：

- 第一轮先不重写。
- 只有在新 `main` 上仍然出现多 tab 重复消息，或长历史重连性能问题时，再单独评估。

## 建议放弃的旧功能或旧实现

### 旧 `main` 的 SDK 依赖升级提交

放弃。upstream 现在更新，而且已经包含 YOKE、Claude 和 Codex adapter 的新机制。

### 旧 worktree 实现

不要直接重放旧实现。upstream 现在已经有：

- `lib/daemon-projects.js`
- `sidebar-projects.js` 中的 worktree 分组
- `daemon.js` 中的 worktree 项目生命周期处理
- 移动端 worktree 展示

只有发现具体回归时，再做定点修复。

### 旧 rewind 补丁

不要直接重放旧实现。upstream 现在通过 `sdk-bridge.js` 和 YOKE adapters 使用统一的 rewind/fork 接口。

只有在下面问题仍存在时再回头处理：

- rewind 后不能在 Claude resume 中持久化；
- fork 时错误地包含被点击的用户消息。

### 旧 Appearance settings 实现

放弃。upstream 已经有更完整的 Appearance section 和 theme picker。

后续注意：

- upstream 目前仍用 `localStorage` 做 theme preference 的启动期恢复。
- 项目规则要求用户设置应存到服务端，所以 theme preference 存储可以之后单独 review。

### 旧 `LOCALCHANGES.md`

放弃。当前迁移以这份 rebuild plan 作为跟踪文档。

## 建议实施顺序

1. 先实现包名、发布目标和 CLI/updater 文案调整。
2. 按新的 client 模块结构实现 `@` 文件系统补全。
3. 跑定向检查：
   - client import check
   - package metadata sanity check
   - 如有需要，做一次浏览器 smoke test
4. 必须项稳定后，再逐个 review 候选 UX 功能。
