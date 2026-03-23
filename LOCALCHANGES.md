# Local Changes

以下是基于 upstream 的本地修改。每次同步 upstream 后，可按需重新实现。

---

## 1. Rewind 后恢复用户消息到输入框

**问题**：用户 rewind 到某条消息后，想基于原文修改重发，但输入框是空的，需要手动复制。

**实现要求**：
- 在 `lib/public/modules/rewind.js` 中新增模块级变量 `rewindUserText`，以及导出函数 `getRewindUserText()` 和 `clearRewindUserText()`
- 点击 rewind 按钮时（`initRewind` 中的 click handler），从该消息的 `.bubble` 元素取 `textContent.trim()` 存入 `rewindUserText`
- 在 `lib/public/app.js` 的 `rewind_complete` handler 中，调用 `getRewindUserText()`，若有值则填入 `inputEl.value` 并 `clearRewindUserText()`
- 在 `rewind_error` handler 中调用 `clearRewindUserText()` 清理状态

---

## 2. IME 输入法 Enter 键误触发 AskUserQuestion 提交

**问题**：中日韩输入法用 Enter 确认候选词时，会误触发 AskUserQuestion 卡片中 "Other" 输入框的提交。

**实现要求**：
- 在 `lib/public/modules/tools.js` 的 `renderAskUserQuestion` 函数中，为 `otherInput` 添加 `compositionstart`/`compositionend` 事件监听，用布尔变量 `otherComposing` 追踪 IME 状态
- 在 `otherInput` 的 `keydown` handler 中，Enter 提交条件增加 `!otherComposing` 判断

---

## 3. iOS PWA 键盘弹出时输入框与键盘之间出现大段空白

**问题**：iPhone PWA standalone 模式下，键盘弹出后输入框和键盘之间有巨大间距。原因是底部 `#mobile-tab-bar`（fixed, bottom:0）和 `#input-area` 为 tab bar 预留的 64px padding 在键盘弹出时没有被移除。

**实现要求**：
- 在 `lib/public/modules/notifications.js` 的 `visualViewport` resize 回调中，记录初始视口高度 `fullHeight`，每次 resize 时比较当前高度与初始高度的差值，超过 100px 判定为键盘弹出，在 `#layout` 上切换 `keyboard-open` class
- 在 `lib/public/css/input.css` 的 `@media (max-width: 768px)` 块内添加：
  - `.keyboard-open #mobile-tab-bar { display: none !important; }` 隐藏 tab bar
  - `.keyboard-open #input-area { padding-bottom: 8px; }` 移除为 tab bar 预留的额外 padding

---

## 4. iPad PWA + 外接键盘：闪烁、Shortcuts Bar 遮挡、回车不发送

**问题**：iPad PWA standalone 模式下使用外接键盘时存在三个问题：
1. **闪烁**：`visualViewport` 的 `scroll` 事件在外接键盘场景下高频触发，且 `visualViewport.height` 返回垃圾值（如 -32），导致 `layout.style.height` 被反复设为无意义值，引起布局抖动
2. **Shortcuts Bar 遮挡**：外接键盘检测 `_checkExternalKeyboard` 使用 `visualViewport.height` 判断是否有虚拟键盘，但该值在外接键盘场景下不可靠（WebKit bug #247410），导致 `.ipad-extkey` 不被添加
3. **回车不发送**：原逻辑依赖 `.ipad-extkey` class（600ms 延迟添加），首次按键时 class 未就绪

**根因**：WebKit bug https://bugs.webkit.org/show_bug.cgi?id=247410 — iPadOS + 外接键盘时 `visualViewport.height` 返回错误值。VSCode 团队确认 `window.innerHeight` 在 iPad 上可靠。

**实现要求**：

### 4a. notifications.js — viewport 处理重写

- `fullHeight` 基准值改用 `window.innerHeight`（可靠）而非 `visualViewport.height`（iPadOS 外接键盘时不可靠）
- `onViewportResize` 中读取 `visualViewport.height` 时增加校验：`vvH > 0 && vvH < fullHeight + 50` 时才使用，否则 fallback 到 `fullHeight`
- 只在虚拟键盘打开时（`fullHeight - vpHeight > 100`）才设置 `layout.style.height` 和执行 `scrollTop = 0` / `scrollToBottom()`；无虚拟键盘时清除 inline style 让 CSS `100dvh` 接管
- **完全移除 `visualViewport` 的 `scroll` 事件监听**——iPadOS 外接键盘时该事件高频触发且数据不可靠
- 在 `initNotifications` 开头检测 touch 设备并添加 `.touch-device` class 到 `<html>`

### 4b. notifications.js — 外接键盘检测改用 innerHeight

- `_checkExternalKeyboard` 中的 `_vpFull` 和判断逻辑全部改用 `window.innerHeight` 替代 `visualViewport.height`
- baseline `_extFullH` 通过 `window.addEventListener("resize", ...)` 更新（而非 `visualViewport` resize）
- 不再依赖 `window.visualViewport` 作为整个外接键盘检测段的入口条件（改为仅检测 `"ontouchstart" in window`）

### 4c. input.js — 回车发送逻辑

- Enter 发送的条件从 `!ipad-extkey` 改为 `keyboard-open && !ipad-extkey`
- 含义：只在虚拟键盘确认打开（`.keyboard-open`）且非外接键盘时才阻止 Enter 发送
- 外接键盘场景下 `.keyboard-open` 不会存在（viewport 不会缩小 >100px），Enter 自然走发送逻辑

### 4d. base.css — position:fixed 防止页面漂移

- 新增 `.touch-device, .touch-device body { position: fixed; width: 100%; }` 规则
- 仅作用于 touch 设备（通过 JS 添加的 `.touch-device` class），不影响桌面端
- 目的：阻止 iPadOS 在 input 聚焦时通过 viewport offset 移动文档（`overflow: hidden` 不够）

### 4e. notifications.js — visualViewport scroll 事件归零 viewport offset

- 在 touch 设备上监听 `visualViewport` 的 `scroll` 事件，当 `offsetTop > 0` 时调用 `window.scrollTo(0, 0)` 将 visual viewport 推回原点
- 原因：即使有 `position: fixed`，iPadOS 仍会在 Shortcuts Bar 出现时通过 visual viewport panning 将页面向上平移，这不是 document scroll，`scrollTop` 无法修正，必须通过 `visualViewport scroll` 事件 + `window.scrollTo` 组合归零
- 之前注释说"不要监听 visualViewport scroll 会导致闪烁"——那是在没有 `position: fixed` 时的问题；有了 `position: fixed` 后只需归零 offset 不改 layout height，不会闪烁

### 4f. input.css — Shortcuts Bar padding 补偿

- 新增 `.ipad-extkey #input-area { padding-bottom: calc(var(--safe-bottom) + 55px + 8px); }` 规则
- 原因：5d + 5e 完全阻止了系统对页面的推高行为，因此需要自己用 CSS padding 将输入区域推高避开 Shortcuts Bar（~55px）
- 三层防御的完整组合：`position: fixed`（阻止 document scroll）+ `visualViewport scroll 归零`（阻止 viewport panning）+ `padding 补偿`（自己精确抬高输入框）

---

## 5. Worktree 创建到同级目录 & 任意位置 worktree 可见

**问题**：原实现将 worktree 创建在项目目录内部，且只有项目目录内的 worktree 才标记为 `accessible`。此外 slug 生成不一致——创建时用 `branchName`，rescan 时用 `path.basename`，当分支名含 `/`（如 `feat/login`）时重启后 slug 不匹配，导致 URL 变化和 session 数据孤立。

**实现要求**：

### 5a. worktree.js — 创建路径改为同级目录

- `createWorktree` 中目录名改为 `{parentDirName}-{safeBranch}`（`/` 替换为 `-`），路径为 `path.resolve(resolvedParent, "..", wtDirName)`
- 示例：项目 `my-app` 创建分支 `feat/login` → 目录 `../my-app-feat-login`

### 5b. worktree.js — accessible 无条件 true

- `scanWorktrees` 中移除 `resolvedWt.indexOf(resolvedParent + path.sep) === 0` 检查，所有 git 报告的 worktree 均为 `accessible = true`
- 新增 `absPath` 字段存储解析后的绝对路径
- 新增 `slugSuffix` 字段：优先用 `branch.replace(/\//g, "-")`，fallback 到 `dirName`，保证创建和 rescan 时 slug 一致

### 5c. daemon.js — worktreeRegistry 改为存储对象

- `worktreeRegistry` 类型从 `parentSlug -> [wtSlug, ...]` 改为 `parentSlug -> [{ slug, path }, ...]`
- 所有引用处（注册、查找、过滤、清理）同步改为对象访问
- slug 生成统一用 `slugSuffix`（rescan）或 `branchName.replace(/\//g, "-")`（创建时）

### 5d. daemon.js — removeWorktree 用绝对路径

- 删除 worktree 时从 registry 中查找绝对路径，直接传给 `removeWorktree(parentPath, wtAbsPath)`
- `removeWorktree` 函数签名从 `(projectPath, worktreeDirName)` 改为 `(projectPath, wtAbsPath)`

### 5e. daemon.js — rescan 匹配改用绝对路径

- `rescanWorktrees` 中新增/移除 worktree 的匹配逻辑从 `dirName` 改为 `absPath`，避免同名目录误匹配

### 5f. sidebar.js — 分支名不做 sanitize

- 前端 `showWorktreeModal` 中移除 `branch.replace(/\//g, "-")`，将用户输入的原始分支名直接发送给后端
- 原因：后端 `createWorktree` 已对目录名做 `safeBranch` 处理，前端多做一次导致分支名中 `/` 被替换为 `-`（如 `feat/login` 变成 `feat-login`）

### 5g. worktree.js — scanWorktrees 前先执行 git worktree prune

- `scanWorktrees` 在 `git worktree list --porcelain` 前先调用 `git worktree prune`
- 原因：worktree 目录被外部删除后，git 元数据仍残留，`git worktree list` 仍会报告已不存在的 worktree，导致 rescan 无法正确检测删除

### 5h. daemon.js — rescan 定时器无条件启动

- `scanAndRegisterWorktrees` 移除 `if (worktrees.length === 0) return` 提前返回，所有 git 项目启动时都无条件启动 10s rescan 定时器
- 目的：通过命令行 `git worktree add` 创建的 worktree 也能被自动发现和注册

### 5i. daemon.js — onCreateWorktree 补启 rescan 定时器

- `onCreateWorktree` 中创建 worktree 后检查 `worktreeTimers[parentSlug]`，若无则启动 rescan 定时器
- 覆盖场景：项目首次通过 UI 创建 worktree 时，确保后续删除能被定时器回收

---

## 6. Rewind 使用 SDK forkSession 替代 resumeSessionAt

**问题**：原 rewind 实现使用 `resumeSessionAt` 在 resume 时截断历史，但这只影响 Clay 侧的 UI 显示——SDK 内部的 session 文件（`~/.claude/projects/` 下的 JSONL）未被修改。用 `claude resume` 恢复该 session 时看到的仍是完整历史，rewind 完全无效。

**根因**：`resumeSessionAt` 是 SDK 启动时的一次性参数，不会持久化修改 session 文件。需要使用 SDK 提供的 `forkSession()` API 真正截断并创建新 session。

**实现要求**：

### 6a. project.js — rewind 逻辑改用 forkSession

- 移除 `lastRewindUuid` 的计算和赋值逻辑
- rewind 时调用 `sdkMod.forkSession(oldCliSessionId, { upToMessageId: msg.uuid, dir: cwd })` 创建截断后的新 session
- 将 `session.cliSessionId` 更新为 fork 返回的新 sessionId
- 删除旧的 Clay session 文件（`~/.clay/sessions/` 下的 JSONL），新文件由后续 `saveSessionFile` 写入

### 6b. sdk-bridge.js — 移除 resumeSessionAt 逻辑

- 从 `queryOptions` 构建逻辑中移除 `session.lastRewindUuid` 和 `resumeSessionAt` 相关代码（两处：主 query 和 worker query）

### 6c. sessions.js — 移除 lastRewindUuid 持久化

- `saveSessionFile` 中移除 `lastRewindUuid` 的序列化
- `loadAllSessions` 中移除 `lastRewindUuid` 的反序列化
