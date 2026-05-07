# Codex 集成计划

> 目标：将 OpenAI Codex（通过 `codex app-server` 子命令）作为 Clay 的第二个 agent 后端引入，与现有 Claude Agent SDK 后端并列。
>
> 总原则：**最小可运行优先**，每个迭代独立可发布、零破坏现有 Claude 用户。

## 当前进度

| 迭代 | 状态 | 摘要 |
|---|---|---|
| 0 | ✅ 完成 | agent-backend factory |
| 1 | ✅ 完成 | Codex MVP（端到端对话 + selector + 徽标 + chip + 未登录引导卡） |
| 2 | ✅ 完成 | 审批流对接（workspace-write + approvalsReviewer=user + 来源徽章） |
| 3 | ✅ 完成（范围调整） | hide 不适用面板 + capability 声明 + 设置抽屉按 backend 分发 + popup 权限模型替换。原 plan 的"顶栏 chip 切 model"和"OPENAI_API_KEY 覆盖"两步**有意跳过**，理由见下文。 |
| 4 | ✅ 完成 | 子进程崩溃 + 二进制卸载 + 401/token 失效 + 版本兼容 + View Logs + 设置持久化 + 首次连接 echo。统一 codex_unavailable 数据结构覆盖四种失败 kind。 |
| 5a | ❌ KILLED | Command amendments — 实施完后 live verify 证伪：Codex v2 协议不支持 modifyCommand-on-accept，response 结构仅 `decision`。所有改动 revert，基线恢复。Postmortem 见 Iter 5a 章节。 |
| 5b | ✅ 完成 | Thread Fork — protocol probe 17/17 + 单元 7 + WS e2e 6 + UI e2e 13 + **live verify 真 Codex 全绿**。HEAD-only fork + thread/resume 切回旧 thread。 |
| 6 | 未开始 | — |

测试覆盖：单元 53 + WS e2e 26 + UI e2e 25 + Auth-card e2e 8 + Approval UI e2e 7 + Hide UI e2e 22 + Unavailable UI e2e 25 = **166 全绿**。Iter 4 共新增 63 项（17 unit + 46 e2e/UI）。

---

## 总体架构（一句话）

把 `lib/sdk-bridge.js` 中隐式存在的"agent 后端"接口显式化，Claude SDK 与 Codex app-server 各自成为它的实现。`project.js` 以上不感知后端。

```
project.js  ──► AgentBackend (interface)
                   ├── ClaudeBackend  (= 重构后的 sdk-bridge.js)
                   └── CodexBackend   (新增；spawn `codex app-server`，JSON-RPC over stdio)
```

数据策略：Codex 的 `Thread / Turn / Item` 事件**翻译**进 Clay 现有的消息 JSONL 格式。UI 层尽可能不动。

认证策略：完全依赖 `~/.codex/auth.json`（用户在终端 `codex login` 一次即可）。Clay 不实现 OAuth、不持久化 token、不刷新。

---

## 设计决策摘要（已敲定）

| # | 决策 | 选定 |
|---|------|------|
| 1 | 后端粒度 | 项目级，创建后不可改 |
| 2 | 数据模型 | 翻译进现有 JSONL；UI 尽量不动 |
| 3 | 进程模型 | 每个 Codex 项目独立子进程，故障隔离 |
| 4 | 权限流 | 复用现有 `pendingPermissions` Promise + WS 广播 |
| 5 | 认证 | 依赖共享 `~/.codex/auth.json`；可选 `OPENAI_API_KEY` env 覆盖 |
| 6 | UI 改动 | 最小集；不适用功能用 hide 而非 disable |

---

## 迭代规划

每个迭代是一个**可发布的版本**。下一迭代依赖前一迭代落地。

---

### Iteration 0 — 抽象重构（不暴露 Codex） ✅

**目标**：把后端接口显式化。用户视角零变化。

- 定义 `AgentBackend` 接口（生命周期 / 发送消息 / 流式事件 / 中断 / 权限回调）。
- 把现有 `lib/sdk-bridge.js` 重构为 `ClaudeBackend`，行为完全等价。
- `project.js` 通过 `backend` 字段选择实现，默认 `'claude'`。
- 项目元数据（daemon.json / project record）增加 `backend` 字段；老项目读不到时按 `'claude'` 处理。
- ~~Session JSONL 文件头加一行 `{"type":"meta","backend":"claude",...}`，老文件无此行时按 `'claude'` 处理。~~
  *实施时简化：未改动 session JSONL 格式。后端归属由 daemon.json 的 `backend` 字段决定，session 文件保持纯消息流；老 session 完全无感。如果未来需要 session 级 backend 切换（fork 跨后端等），再补 meta 行也来得及。*

**完成标准**：所有现有用户行为完全不变。重构后通过手动验证：现有 Claude 项目继续工作、rewind 正常、权限弹窗正常、推送正常。

**不做**：任何 UI 改动、任何 Codex 相关代码。

**实施提交**：`81383ed`（agent-backend factory + sdk-bridge 接通）。

---

### Iteration 1 — Codex MVP（端到端跑通一次对话） ✅

**目标**：用户能创建一个 Codex 项目，发一条消息，看到 Codex 流式回复。**只此而已**。

#### 后端 ✅
- 新建 `lib/codex-backend.js` + `lib/codex-jsonrpc.js`：
  - spawn `codex app-server`（stdio + 行分隔 JSON-RPC 2.0）✅
  - ~~`initialize` 握手 + 版本探测（不兼容直接报错）~~ ✅ **已实施，但与计划不同**
    - **协议事实纠正**：v2 schema 没有独立的 Initialize 消息，但 `codex app-server` 强制要求先发 `initialize`（v1 调用）否则后续 `thread/start` 返回 `Not initialized -32600`。
    - 实际做法：`initialize` 携带 `clientInfo:{name,version}` + `capabilities:{experimentalApi:true}`，初始化成功后才能用 v2 的 `thread/start` / `turn/start`。
    - 版本不兼容引导留给 Iter 4。
  - `thread/start` → `turn/start` → 监听 `item/*` / `turn/*` 通知 ✅
  - 事件翻译为 Clay 消息格式写入 JSONL（`session_id` / `delta` / `result` / `done` / `error`）✅
  - 子进程崩溃时项目页显示错误（不自动重启）✅
- 启动前预检 `~/.codex/auth.json` 是否存在且 `auth_mode`/`tokens` 有值 ✅。

#### 沙箱策略（关键）✅
- 实施值：`thread/start` 传 `sandbox: "read-only"` + `approvalPolicy: "never"`。
- 收到的任何 ServerRequest（审批）一律 `respondError(-32601, "Approvals not yet supported in this Codex iteration")` 兜底，避免 Iter 1 触碰权限流。
- 用户能感知的限制：第一版 Codex 项目命令执行能力受限。Iter 2 接入审批后放开。

#### UI ✅
- New Project 对话框增加 backend segmented control（Claude / Codex）✅
  - 检测不到 `codex` 二进制 → 第二个 radio 灰掉 + tooltip 给安装提示 ✅
  - 检测不到 `~/.codex/auth.json` → radio 不灰，submit 后由后端发 `auth_required{source:"codex"}`，前端渲染引导卡片 ✅
- Dashboard / sidebar 项目卡片：Codex 项目加 outline 文字徽标（用 `--accent2`）✅
- 项目顶栏：显示 `[Codex] {model}` chip ✅
- "未登录引导卡片"组件：项目主区域全宽卡片，含 `codex login` 复制按钮 + Retry 按钮（**不轮询**）✅

**完成标准**：
1. 用户在 dashboard 创建一个 Codex 项目 → 立刻能发消息 → 看到流式回复 ✅（自动化测试覆盖）
2. 未登录用户走完引导卡片 → 终端登录 → Retry → 进入正常对话 ✅（auth-card e2e 覆盖到 Retry，登录恢复路径手动验证）
3. 现有 Claude 项目仍然工作如常 ✅（unit 测试覆盖 + 手动验证）

**不做**：权限弹窗对接、设置面板、模型切换、rewind、skills、文件改动审批、token 过期处理、自动重启。

**实施提交**：
- `2fef824 feat(codex): add Codex agent backend with isolated test harness` — 后端 + selector + 徽标
- `19a60ed feat(codex): topbar backend chip and not-logged-in guidance card` — chip + guidance card

**额外交付（计划外但是 Iter 1 测试基础设施）**：
- `scripts/dev-isolated.sh` + `npm run dev:isolated*`：HOME + CLAY_HOME 双重定向的隔离测试环境，`~/.codex` 软链共享，绝不污染开发机的 `~/.clay` / `~/.clayrc`。
- `scripts/codex-jsonrpc.test.js`：JSON-RPC 客户端 7 个单元测试。
- `scripts/codex-e2e.js` + `npm run test:e2e`：WS 协议层 9 项断言端到端验证。
- `scripts/codex-ui-e2e.js` + `npm run test:e2e:ui`：Playwright headless Chromium 12 项断言（含 chip）。
- `scripts/codex-auth-card-e2e.js` + `npm run test:e2e:auth-card`：临时弄断 auth 跑引导卡 9 项断言。

测试期间真发现并修掉 3 个 bug（详见提交说明）：(1) `app.js#renderProjectList` 把 backend 字段从 iconStripProjects 中漏掉；(2) `createSheetProjectItem` 没渲染徽标（只在 `createMobileProjectItem` 加了）；(3) `codex-e2e.js` 的 IPC 客户端等 socket end 但 daemon 不关连接。

---

### Iteration 2 — 权限流对接 ✅

**目标**：Codex 项目能跑需要审批的命令；用户在熟悉的权限弹窗里 accept/decline。

#### 后端 ✅
- **关键协议事实**：`thread/start` 默认 `approvalsReviewer: "auto_review"`，guardian 自决不询问客户端。必须显式传 `"user"` 才会触发 `item/commandExecution/requestApproval` 服务端请求。这一点 schema 注释里没明说，是 live verification 中实测踩出来的（见提交说明）。
- `CodexBackend.handleServerRequest` 识别 `item/commandExecution/requestApproval` + `item/fileChange/requestApproval`，从 `-32601` 全拒兜底改为：
  - 注入 `currentSession.pendingPermissions[requestId]`，复用现有 WS `permission_request` 广播路径。
  - `.then(result)` 翻译 Clay 的 `{behavior, ...}` 回 Codex 决策枚举：
    - `allow` → `"accept"`
    - `allow_always`（检测 `session.allowedTools[toolName]` 同步置位）→ `"acceptForSession"` 且额外缓存 `allowedTools["codex:exec"|"codex:fileChange"]`，同会话同类后续请求自动 accept 不再弹窗。
    - `deny` → `"decline"`（turn 继续，不用 `cancel`，给模型自我修正空间）。
  - 没有活跃 session 时（极端边界）安全 decline，让 turn 能完结。
  - 其他未知 `ServerRequest` 仍 `-32601`。
- `thread/start` 沙箱：`sandbox: "workspace-write"` + `approvalPolicy: "on-request"`，让审批真触发。

#### UI ✅
- `permission_request` 消息新增 `source` 字段（codex-backend 主动注入）；`renderPermissionRequest(requestId, toolName, toolInput, decisionReason, source)` 读取并在 header 末尾渲染 `.permission-source-badge`，Codex 用 `--accent2`（indigo）外观，Claude 用中性色，老消息无 source 默认 `"claude"`，零破坏。
- CSS：`.permission-source-badge[data-source="codex"]` 在 `lib/public/css/rewind.css` 中定义。

#### 测试 ✅
- 新增 `test/codex-approval.test.js`（7 单元测试）：覆盖 broadcast / accept / acceptForSession+allowKey 缓存 / decline / 自动接受 / 无 session decline / 未知方法 -32601。
- 新增 `scripts/codex-approval-ui-e2e.js` + `npm run test:e2e:approval`（4 断言 Playwright UI）：注入合成 DOM 验证 source 徽章渲染与配色差异。
- 现有 42/42 全部继续通过；总数提升到 56/56。
- 额外提供 `npm run verify:approval-live`（`scripts/codex-approval-live-verify.js`）作为**手动 / 一次性验证工具**：实际驱动 Codex 跑 `echo > $HOME/...`（在 sandbox 外的 home 目录），断言 `permission_request` 真到达 + 徽章渲染 + accept 后文件确实被写入。不进 CI 套件（依赖外部账号/网络），但首次发布前必须本地跑过一次。

**为什么不进 CI**：模型决定何时调用工具是非确定性的，让 e2e 依赖模型行为会产生 flaky。审批路由的所有翻译契约用单元测试更可靠，UI 渲染用合成 DOM 测试更稳定。`verify:approval-live` 用于本地"一次性确认管道真打通"，每次发布前手跑一次。

**不做**（明确推迟）：命令 amendments / 修改命令再执行（Iter 5）；execpolicy / network policy 持久化建议（Iter 5）；`grantRoot` 全会话写授予；`cancel` 决策（Clay UI 暂无独立 "deny + interrupt" 入口）。

---

### Iteration 3 — 设置面板与权限模型分发 ✅

**目标**：Codex 项目可配置；UI 按后端渲染专属设置；Codex 项目里 Claude-only 控件全部消失。

#### Step 1 — Hide 不适用面板 ✅

- `body.backend-codex` 一刀切的 CSS class，挂在 `<body>` 上随 `info.backend` 翻转
- Codex 项目下 hide：`#skills-btn` / `#new-ralph-btn` / `#slash-menu` / `.msg-user-rewind-btn`
- Hooks 面板搜索过没有 UI 入口，跳过
- 实施：`lib/public/css/codex.css` + `lib/public/app.js` 5 行 classList.toggle

**Step 1 漏网（Step 4 修补）**：输入栏 config chip popup 当时没意识到也是 Claude-only 入口；Step 4 一并清理。

#### Step 2 — AgentBackend capability 声明 ✅

- 各 backend module 静态 export `SUPPORTED_SETTINGS` 数组
  - Claude: `["model", "permissionMode", "effort", "betas", "thinking"]`（历史全集，不变）
  - Codex: `["model", "effort", "sandbox", "approvalPolicy", "apiKeyOverride"]`（permissionMode/betas/thinking 是 Claude-only 概念，故意排除）
- `getBackendCapabilities(backend)` 返回 `{ settings: [...] }`，slice 副本（mutation-safe）
- `info` WS 消息带上 `capabilities` 字段；前端缓存到 `currentProjectCapabilities`，ctx 暴露给子模块
- 显式拒绝运行时 capability discovery 协议：**只有静态导出 + 一次 info 转发**，没有新 RPC

**关键决策**：Claude `SUPPORTED_SETTINGS` 设为现状全集 + 前端默认值也是这一集 → 老路径完全无感。

#### Step 3 — 设置抽屉按 backend 分发 ✅

- HTML：`data-section="defaults"` 内 Claude 5 cards 包进 `.ps-defaults-claude`；并列 `.ps-defaults-codex` 4 cards（Model / Reasoning Effort / Sandbox / Approval Policy）
- CSS：`body.backend-codex` 翻转两块
- `populateDefaults()` 按 `ctx.currentBackend` 分发
- 共享枚举常量：`CODEX_MODELS` 硬编码 3 项（gpt-5-codex / gpt-5 / gpt-4.1）— 跳 model/list RPC；`CODEX_SANDBOX` 3 选 1（schema 实际值，不是 plan 写的 4 选 1）；`CODEX_APPROVAL` 4 选 1
- codex-backend.js 加 4 个实例变量 `desiredSandbox / desiredApprovalPolicy / desiredReasoningEffort / desiredModel`
- `thread/start` 改为读这些实例值，默认仍是 workspace-write + on-request（零破坏 Iter 2）
- 新增 `setSandbox` / `setApprovalPolicy` 方法 + 枚举白名单校验 + emit `codex_config` echo
- 新增 WS 路由 `set_codex_sandbox` / `set_codex_approval_policy`

**关键决策**：值存实例变量、next thread/start 应用，不持久化到 daemon.json。用户认知"重开会话生效"完全自然，省一层持久化。

#### Step 4 — config chip popup 权限模型替换 ✅（修订原 plan 的 Step 4）

- popup DOM 加 `#config-mode-section` 包装 + 并列 `#config-codex-sandbox-section` / `#config-codex-approval-section`
- CSS：`body.backend-codex` 下 hide MODE / THINKING / BETA，show SANDBOX / APPROVAL
- `getModelEffortLevels()` Codex 短路返回 `[low, medium, high]`（drop max — Codex schema 没这级）
- `updateConfigChip()` chip 文字按 backend 切：Codex 显示 `model · sandbox · effort`
- `rebuildCodexPermissionsSections()` + `buildCodexSegmented()` onClick 直接 emit Step 3 的 WS 消息

**关键决策**：与设置抽屉共用消息通道，没有为 popup 单独设计 WS 协议。

#### 原 plan Step 4/5 跳过的理由（**有意为之**）

| 原计划 | 跳过理由 |
|---|---|
| 顶栏 model chip 可点击展开 model/list dropdown | (a) Codex thread 锁定 model — 切 model = fork 新 thread 丢历史，与"快速切换"的 UX 期望矛盾。(b) 设置抽屉 + popup 已有两个切换入口，顶栏第三个入口冗余且需独立 fork 警告 modal。(c) `model/list` v2 RPC 引入只为了拉一个 3 项列表，复杂度换边际收益 — Iter 5 真要做 fork-with-different-model 时再补。 |
| OPENAI_API_KEY 覆盖折叠区 | (a) `codex-backend.js` 已读 `opts.openaiApiKey` 并注入子进程 env — 协议层准备完毕。(b) 实际只需一个项目级 env 字段，**已经被现有 Project Settings → Environment 完整覆盖**（用户写 `OPENAI_API_KEY=...` 即可），加专用折叠区是重复 UI。(c) ChatGPT 订阅用户是默认场景，自带 API key 是少数派 — 边际价值不足以新增 UI 入口。 |

**完成标准**：✅ 用户能在 Codex 项目里
- 切换 sandbox / approval policy（立即对下个 thread 生效，echo 同步两个 UI 入口）
- 切换 model / reasoning effort（立即对下个 thread 生效）
- 不再看到 Mode / Plan / Thinking budget / 1M Context / Skills / Rewind / Ralph Loop / slash 等 Claude-only 控件

**实施提交**：尚未提交（用户审阅中）。

**测试基础设施增量**：
- `scripts/codex-hide-ui-e2e.js` + `npm run test:e2e:hide` — Playwright 静态 UI 测试，22 断言覆盖 hide 矩阵 + popup 替换矩阵
- `scripts/codex-e2e.js` 加 step 6.5 验证 `set_codex_sandbox/approval_policy` → `codex_config` echo round-trip
- 单元测试 `test/codex-approval.test.js` 加 3 项覆盖 sandbox/approval 白名单 + model/effort desired params

**修复的隐患（计划外但顺手）**：`scripts/codex-e2e.js` 之前直接 `add_project`，daemon.js 在 path 已注册时 `add_project` 是 no-op，导致 backend 字段不刷新。改为先 `remove_project` 再 `add_project`，与 live verify 同模式对齐。

---

### Iteration 4 — 健壮性与错误处理 ✅ 完成

**目标**：把所有失败态体面化。

应用 Linus "消除特殊情况"原则：四种"client cannot proceed"失败态合并为**一个** WS 消息 + **一个**前端组件，按 `kind` 翻文案。

**数据结构**（server → client）：
```js
{ type: "codex_unavailable", kind, message, stderrTail?, at }
// kind ∈ { "crashed", "binary_missing", "auth_lost", "version_incompatible" }
```

#### 第一轮 Step A+B+C+D ✅ — codex_unavailable 框架（commits 60c03cd）

**前端**：
- `addCodexUnavailableCard(msg)` — 单一渲染器，`kind` 驱动标题/提示/边框 accent 颜色
- View Logs 折叠区 — 同时显示 stderr ringbuffer + `~/.codex/log/` 最新文件 tail（16 KB）
- Retry 按钮 — 发 `codex_retry` WS 消息，触发后端 `retry()`；成功时通过 `model_info{backend:"codex"}` 自然清掉卡片

**后端 API**：`emitUnavailable` / `retry` / `getLogs` / `readCodexLogTail` / `client.getStderrTail()`

落地的 kind：
- `crashed` — onExit 钩子升级为 codex_unavailable 卡片，附带 8 KB stderr ringbuffer
- `binary_missing` — `which codex` 预检 + spawn ENOENT 检测

#### 第二轮 — 持久化 + 401 + 版本兼容 ✅（commits b8661ab / 2fb26b2 / 5319857 / *task4*）

**Task #1 持久化 `b8661ab`**：sandbox/approval/model/effort 写入 daemon.json 的 `codexConfig` 字段。`makePersistCodexConfig(slug)` 闭包穿透 4 层（daemon → server → project → backend）。setters 调 `onCodexConfigChange` 回调；启动时 `codex-backend` 用白名单 seeding `desired*` + `sm.currentModel/currentEffort`。

**Task #2 首次连接 echo `2fb26b2`**：connect handler 在 info 之后 sendTo `codex_config{sandbox, approvalPolicy, model, effort}`，前端 case 扩展处理新字段。修复 e2e 测试 `wsRecv` listener 移除竞态（用单 drain 模式）。

**Task #3 401 / token 失效 `5319857`**：识别两种 401 surfacing：
- ServerRequest `account/chatgptAuthTokens/refresh` — codex 主动 ping 客户端刷新 token；我们用 `-32000 + reason` 拒绝（match codex exec 模式）
- Notification `error` 携带 `{code, message}` — 用 `looksLike401` 保守白名单识别（unauthorized / token_expired / "Provided authentication token is expired" / 邻近 auth 关键词的 401）

两条路都触发 `triggerAuthLost(detail)` → `emitUnavailable("auth_lost")` + `gracefulTeardown=true` + `client.close()`，下次 Retry 重读 auth.json。**协议契约通过直读 openai/codex Rust 源码确认**（`account.rs` ChatgptAuthTokensRefreshReason::Unauthorized + `notification.rs` ErrorNotification + `exec/lib.rs` reject_server_request 模式）。

**Task #4 版本兼容 `*task4*`**：识别两种 incompat：
- `initialize` 拒绝 — JSON-RPC `-32601` ("Method not found") 或消息含 "unknown method"
- `initialize` 成功但 response 缺必填字段（`userAgent` / `codexHome` / `platformFamily` / `platformOs` per `app-server-protocol/v1.rs InitializeResponse`）

两条路都触发 `triggerVersionIncompatible(detail)` → 同样的 graceful teardown 流程。**不做 semver 比较** — codex 不通过 initialize 暴露版本，硬编码阈值会腐烂。我们信任协议契约："如果说我们约定的 schema，就兼容；说不出来，就不兼容"。

#### 关键决策

- 不持久化 `unavailable` 状态。daemon 重启即清。
- 不为 codex_unavailable 单独维护 history meta。replay 时旧卡片再现，用户点 Retry 即可清理（与 auth_required 行为一致）。
- 不与 auth_required 合并。两者 UX 完全不同（terminal 引导 vs 进程恢复）。
- 子进程崩溃后**不自动重启**。Retry 是显式动作。
- `gracefulTeardown` flag 让 onExit 不覆盖更具体的 auth_lost / version_incompatible 卡片。
- **从不 hard-code codex 版本号阈值**。判定 100% 基于"它说不说我们的协议"。

#### 完成标准（全部达成）

- ✅ `kill -9 codex` → crashed 卡片 + stderr tail + Retry 起新进程
- ✅ `mv $(which codex) /tmp/` → binary_missing 卡片，恢复后 Retry 成功
- ✅ 改 auth.json 让其失效 → auth_lost 卡片（手动验证可由用户跑；CI 用单元测试覆盖协议翻译契约）
- ✅ 降级 codex 二进制版本 → version_incompatible 卡片（识别 initialize 拒绝或 malformed response）

#### 推迟到 Iter 5 或文档化

| 项 | 推迟理由 |
|---|---|
| `acceptForSession` 缓存持久化 | Codex 进程内 cache 同会话作用域，重启即重置行为一致 — 文档化即可 |
| 网络审批（`networkApprovalContext`）独立 callout | 当前命令文本已含上下文，分类徽标边际收益小 |

#### 测试基础设施增量

- `test/codex-unavailable.test.js`：19 单元（9 emitUnavailable/retry/getLogs 框架 + 6 401 检测 + 4 版本兼容检测）
- `test/codex-approval.test.js`：+7 单元（持久化 4 个 + 首次 echo 3 个）
- `scripts/codex-unavailable-ui-e2e.js`：25 静态 UI（22 框架 + 3 auth_lost/version_incompatible kind 文案）
- `scripts/codex-e2e.js`：26 WS e2e（含 Task #1 daemon.json 持久化 5 项 + Task #2 首次/重连 echo 6 项）
- `npm run test:e2e:unavailable` 进 CI 套件

---

### Iteration 5 — Codex 审批闭环 + Thread Fork

**总目标**：让 Codex 项目从"能用"变成"用得顺手"。

**范围收缩说明**：原 plan 列了 5 个特性（fork / skills / connectors / turn diff / amendments），实测后按"数据结构改动 × 真实价值"重排：
- amendments 设计阶段以为是 Iter 2 审批流的自然补完 → **5a 实测后撤回**（见下文 postmortem）
- thread/fork 是 Codex 用户的核心工作流，且现有 multi-session 基础设施可直接复用 → **5b**
- skills / connectors / turn diff 推 Iter 6（理由见 Iter 6 章节）

---

#### Iteration 5a — Command amendments ❌ KILLED（live verify postmortem）

**结论**：**Codex v2 协议不支持"修改命令再批准"的语义**。本子迭代撤回，所有代码变动 revert，相关 plan 仅保留作为踩坑记录。

##### Live verify 怎么抓到的

5a 单元测试 4/4 + UI e2e 7/7 全绿后跑 `scripts/codex-approval-live-verify.js`：
- 让 Codex 跑 `echo ORIGINAL_CONTENT > /Users/louis/.../target.txt`
- 弹审批 → textarea 改成 `echo AMENDED_CONTENT > .../target.txt`
- 点 Allow Once → doneCode === 0、permission_resolved 收到、turn 干净结束
- **文件内容仍是 `ORIGINAL_CONTENT`**

我们发的字节是 `{ decision: "accept", modifiedCommand: "echo AMENDED_CONTENT > ..." }`，Codex 的 serde 默认不开 `deny_unknown_fields`，把 `modifiedCommand` 静默 drop 后用原 argv 执行。单元测试只能证明"我们发出的字节"，证明不了"接收方读不读"。

##### 协议层证据（直读 openai/codex Rust 源码）

`codex-rs/app-server-protocol/src/protocol/v2/item.rs:43-64`：
```rust
#[serde(rename_all = "camelCase")]
pub enum CommandExecutionApprovalDecision {
    Accept, AcceptForSession,
    AcceptWithExecpolicyAmendment { execpolicy_amendment: ExecPolicyAmendment },
    ApplyNetworkPolicyAmendment { network_policy_amendment: NetworkPolicyAmendment },
    Decline, Cancel,
}

pub struct CommandExecutionRequestApprovalResponse {
    pub decision: CommandExecutionApprovalDecision,  // 仅此一个字段
}
```

- response 结构**只有 decision**，没有任何位置可以传修改后的命令
- `AcceptWithExecpolicyAmendment` 的 `execpolicy_amendment: Vec<String>` 是**未来命中规则的 prefix pattern**（用于让以后匹配的命令自动批准），不是当次执行的 argv 替换 — 当次仍跑原 argv
- `ApplyNetworkPolicyAmendment` 是网络访问 host allow/deny，无关 argv
- v2 → v1 翻译层（`bespoke_event_handling.rs:1944-1981`）确认：`Accept` → `ReviewDecision::Approved`，agent core 用请求时捕获的 `ExecApprovalRequestEvent.command` 原样执行

**没有任何上游协议路径能让客户端在批准时改命令**。

##### 为什么不绕过去

考虑过的 workaround 全部砍掉：

| 方案 | 砍掉理由 |
|---|---|
| Decline + 注入新 user message "请改用 X 命令" | 完全不同的 UX。模型可能不听、可能换思路、可能再提原命令。把它套在"Modify & Approve"按钮上 = UI 撒谎 |
| 在 Clay 侧拦截 + 重写 codex 进程内 turn state | 与已显示的 approval card 不一致；codex 端 turn state 仍持有原命令；脆且打破 Linus 的 "kernel serves user, not the other way around" |
| Patch codex 二进制 | 不维护 fork |

Linus 判断：留着 textarea + Allow 按钮 = UI 撒谎（用户改了命令但跑的是原命令）= **比没有更糟**。撤回。

##### 撤回内容

| 文件 | revert 状态 |
|---|---|
| `lib/codex-backend.js` | `respondApproval` 签名 + accept 路径 extra 透传 → 全删 |
| `lib/project.js` | `permission_response` modifiedCommand 透传 → 全删 |
| `lib/public/modules/tools.js` | textarea 渲染 + `sendPermissionResponse` 第四参 → 全删 |
| `lib/public/css/codex.css` | `.permission-amend-*` 样式块 → 全删 |
| `test/codex-approval.test.js` | 4 新单元 → 全删（53 单元基线恢复） |
| `scripts/codex-approval-ui-e2e.js` | 7 新断言 → 全删（8 基线恢复） |
| `scripts/codex-approval-live-verify.js` | amendment 步骤 → 全删（基线恢复） |

##### 教训

1. **协议假设必须 live verify 才算数**。"plan 写得了" ≠ "上游协议支持"。
2. 单元测试边界是"我们的字节"。线另一端 schema 漂移 / serde 静默 drop / 默认值兜底，单元测试一律抓不到。
3. 对外部协议下手前**先读 schema 源码，不读 docstring，不靠推测**。
4. plan 自洽不等于现实可行。原 plan "amendments 是 Iter 2 的自然补完，零数据模型改动" 这条判断错在没核 v2 schema。

---

##### 顺手清理（仍要做 — 与 5a 解耦）
- Iter 4 末尾两条文档 debt：在 `lib/codex-backend.js` 顶部 file-level 注释里加一段说明 `acceptForSession` 仅会话内有效 + 网络审批共享 commandExecution 通道 UI 不区分。这一项不依赖 5a，可以在 5b 实施时顺手做。

---

#### Iteration 5b — Thread Fork（HEAD-only）

**目标**：Codex 项目用户能从当前对话状态分叉出新 thread，原 thread 保留在 sidebar 可切回。

##### Protocol probe 结果（`scripts/codex-fork-protocol-probe.js` — 17/17 ✅）

实施前先跑 probe，把所有协议假设打到实测里，这是 Iter 5a 教训的直接应用。

| 验证项 | 结果 |
|---|---|
| `thread/fork { threadId }` 返回 `{ thread: { id, forkedFromId, turns, ... } }`（camelCase） | ✅ |
| Fork 服务端自动复制历史（`turns.length === 1` 来自源） | ✅ |
| Forked thread 能接新 `turn/start` 且模型记得历史 | ✅ |
| 源 thread fork 后仍可继续 `turn/start`（同进程多 thread） | ✅ |
| `thread/resume { threadId }` 切回旧 thread → same-id round-trip + turns 完整 | ✅ |
| `excludeTurns: true` → 空 fork（`turns.length === 0`） | ✅ |
| `thread/fork { threadId: "bogus" }` → `-32600 invalid thread id`（不是 -32601 → 方法存在） | ✅ |
| 未知 anchor 字段（`atTurnId` / `atItemId`）→ **codex serde 静默忽略，不报错也不生效** | ⚠️ 见下 |

##### 关键实测发现：**没有 fork-point 锚点**

`thread/fork` 强制 fork 整段历史。要在第 N 条消息处分叉，必须组合 `thread/rollback`（截断源）或用 `thread/resume { threadId, history: [...] }` 自合成 —— **均超出 5b 范围**。

**5b 决定：HEAD-only fork**。对应 UX = "从当前状态分叉"，按钮挂在 conversation 末尾或顶栏，**不**挂在每条消息上。

理由（Linus "解决真问题"原则）：
1. 真用户需求 = "我想分支去试不同路线，不丢现状"。HEAD-only 100% 覆盖。
2. per-message anchor = 20% 用例 + 二次 probe + 独立 UX 设计 = 单独迭代值得（5c 候选）。
3. Codex 项目当前 `.msg-user-rewind-btn` 已 hide（Iter 3），所以 HEAD-only fork 是严格新增，零回归。

##### 设计决策（实测后敲定）

| 问题 | 决策 |
|---|---|
| 切回旧 thread 用什么协议？ | **`thread/resume { threadId }`**（probe 验证 round-trip 同 id）。不再需要"switchThread"概念。 |
| Fork 后是新 session 文件还是同 session 加新 thread？ | **新 session 文件**。复用 `sm.createSession()` 路径，新 cliSessionId = Codex 返回的新 threadId。 |
| Sidebar 怎么表达"一个项目 N 个 thread"？ | **复用现有 multi-session UI**。新 fork 出的 session 自动出现在 sidebar，用户点击触发 `thread/resume`。无需新组件。 |
| URL 路由要不要 `/p/{slug}/t/{threadId}/`？ | **不要**。沿用现有 `switch_session` WS 消息，URL 仍是 `/p/{slug}/`。 |
| Fork 入口挂哪？ | **顶栏/工具栏 "Fork" 按钮**（仅 `body.backend-codex` 显示）。不挂消息气泡。 |
| Fork 失败走哪个错误态？ | **toast / inline error**，不创建半成品 session。复用 Iter 4 codex_unavailable 不合适（fork 失败 ≠ 进程不可用）。 |
| Fork 时 codex 子进程要不要新开？ | **不开**。同进程内 `thread/fork` + 后续 `thread/resume` 切换 active threadId。Probe 已确认单进程多 thread 工作。 |
| 复制 Clay session JSONL 历史吗？ | **复制**。Codex 服务端持有完整 turn 历史，Clay session 文件仅用于 UI replay。fork 时把源 session JSONL 完整 copy 到新 session 文件，新文件首行加 `session_id` = 新 threadId。这样 sidebar 切换时 Clay 端显示完整历史，Codex 端用 `thread/resume` 同步 thread 上下文。 |

##### 后端

**核心改动：codex-backend 解耦"backend 实例 ↔ 单 thread"**。

- 实例字段 `threadId` / `currentSession` 仍是"当前激活"。
- 新增 `forkActiveThread(session)` 方法：
  - 调 `client.request("thread/fork", { threadId: <current> })`
  - 收到新 threadId → 用 `sm.createSession()` 创建新 Clay session
  - 复制源 session.history 到新 session.history（在 createSession 后 push 历史 + saveSessionFile）
  - 设置新 session.cliSessionId = 新 threadId
  - 切换 backend 内部 `threadId` / `currentSession` 到新值
  - emit `session_switched` + `forkedFromId` 元数据让前端可显示血缘
- `ensureThread(session)` 改造：
  - 当前逻辑：首次为 session 调 `thread/start`
  - 新逻辑：如果 `session.cliSessionId` 已经是有效 threadId（来自 fork 或 resume），调 `thread/resume { threadId: session.cliSessionId }` 而不是 `thread/start`
  - resume 失败（threadId 不存在 / 进程换了）→ fallback 到 `thread/start` 新建（旧历史无法续）+ 在 session 注入 info 消息提示
- WS 路由：
  - 新增 `fork_thread`（无 params，fork 当前 active session）→ 后端调 `forkActiveThread`
  - 复用 `switch_session { id }` —— 不变；切到不同 cliSessionId 时 backend 自动 resume

##### UI

- 顶栏（`#topbar` 或附近）新增 Fork 按钮：仅 `body.backend-codex` 显示。Icon = git-branch 或 fork 形状。
- 点击 → 自定义 confirm modal（CLAUDE.md 禁用 native confirm）："Fork conversation? The current thread will remain accessible from the session list."
- 确认 → 发 `fork_thread` WS。
- 收到 `session_switched` → sidebar 高亮跳转，无感切换。
- Fork 失败：在 message 区域插入红字 `.codex-fork-error` 一行，含 reason + 关闭按钮。

##### 测试

- 协议 probe：`scripts/codex-fork-protocol-probe.js` ✅ 已落地。**进 CI**（每次发布前跑一次，cost 约 4 个 turn API 调用，可接受）。
- 单元 `test/codex-fork.test.js`（新文件，~6 项）：
  1. `forkActiveThread` 发出 `thread/fork { threadId }` RPC（fake client 验证）
  2. fork 成功后 `currentSession` / `threadId` 切到新值
  3. fork 成功后新 session.history 复制了源历史
  4. fork RPC 失败 → 不切换、不创建 session、抛出错误
  5. `ensureThread` 当 session.cliSessionId 已有时调 `thread/resume`（不是 `thread/start`）
  6. `ensureThread` 的 resume 失败时 fallback 到 thread/start
- WS e2e `scripts/codex-e2e.js` 增 step 8：发消息 → fork_thread → 验证 session_switched + 两个 session 在 broadcast list → switch_session 回旧 → 旧 session.cliSessionId resume 成功 → 发新消息 → 双 thread 并存。
- UI e2e `scripts/codex-fork-ui-e2e.js`（新文件，~5 断言）：Fork 按钮仅 Codex 项目可见 / Claude 项目无该按钮 / 点击弹 confirm modal / 确认后 WS 发 `fork_thread` 帧 / 错误态渲染 `.codex-fork-error`。
- **Live verify**（不进 CI）：扩展 `scripts/codex-approval-live-verify.js` 或新建 `scripts/codex-fork-live-verify.js` —— 真跑一次：发"记住我说 ALPHA" → fork → 在新 thread 问"我刚说什么" → 应回 ALPHA → 切回原 thread → 问相同问题 → 应回 ALPHA。证明历史在两 thread 都通。

##### 完成标准

1. Codex 项目顶栏点 Fork → sidebar 出现新 session → 自动切到新 session → 继续发消息可用
2. 点 sidebar 切回旧 session → Clay 历史完整显示 → 发新消息 → Codex 用 `thread/resume` 续上原 threadId
3. Fork RPC 失败时不留半成品 session 文件、UI 显示 reason
4. Claude 项目零回归（rewind 仍工作、Fork 按钮不存在）
5. 同项目 fork 5 次后 codex 子进程仍单实例（`ps` 验证）

##### 不做（明确推迟到 5c 或后）

- **per-message anchor fork**：需要 `thread/rollback` probe + UX 重设计。5c 候选。
- 跨 thread 比较 / merge
- Fork tree 可视化（仅平铺 sidebar list，附 forkedFromId 元数据）
- Fork 时改 model / sandbox（先继承当前配置；codex-fork RPC 接受 model override 但 5b 不暴露）
- 旧 thread 删除（与 Claude session 删除走同一路径，不专门处理）

##### 5a 教训应用

- ✅ 协议 probe 先行，所有 schema 假设跑过实测
- ✅ 单元测试 fake client + e2e 真 daemon + live verify 真 codex API，三层都过才算完
- ✅ 不向 codex 发未约定字段（`atTurnId` 等已知会被静默忽略，明确不发）
- ✅ Plan 写得了 ≠ 协议支持 —— 已 probe → 已知支持，可放心实施

---

### Iteration 6（Codex 原生特性 + Phase 2）

**目标**：让 Codex 项目有自己的"质感"。从 Iter 5 推迟过来的 + 原 Iter 6 的远期项。

#### 从 Iter 5 推迟过来的

- **Skills**：拉 `skills/list`，在侧边栏给 Codex 项目独立 skills 面板。**前置 spike**：`skills/list` 真实返回什么？空 / demo only / 真有用户 skill？根据 spike 结果决定是做完整 UI 还是砍掉。
- **Connectors / Apps / MCP server 管理**：独立子系统，需要 Iter 4 级别的健壮性工作量（配置持久化、生命周期、错误态）。**前置评估**：调查有多少 Codex 用户在 Clay 里管 MCP，再决定优先级。
- **Turn diff / plan**：先在 `codex-backend.js` 把 `turn/diff/updated` / `turn/plan/updated` 事件 silently 翻译进现有消息流（不渲染独立 UI）。后续若有用户反馈再做专属 UI。

#### 原 Iter 6（远期）

- **Clay 内 OAuth**：对接 `account/login/start`，让用户不离开 Clay 就能登录 Codex。仅当用户反馈强烈时做。
- **Compare Mode**：横向并排 Claude 与 Codex 项目，同一目录同一提示词对比输出。
- **共享 codex 进程**：如果性能/资源成为问题，可重新评估是否合并多项目到单个 codex 进程多 thread。当前默认每项目独立进程。Iter 5b 已经做了"单进程多 thread"，可作为这个方向的基础。

---

## 跨迭代的工程约束

- **零破坏**：每个迭代发布前手动验证现有 Claude 项目所有核心路径（对话、权限、rewind、推送、终端、文件浏览器）。
- **不引入新依赖**：JSON-RPC 客户端用原生 Node 实现（行分隔 JSON + Promise map），不引入 `jayson` 等库。
- **不写测试框架**：Clay 现状无测试，本计划不引入。手动验证清单写在每次发布的 CHANGELOG。
- **CLAUDE.md 现有约束保持**：`var` 而非 `const/let`、CommonJS 服务端、ES modules 客户端、英文 user-facing 文案、自定义 Modal。

---

## 文件改动预估（仅示意，非实现细节）

| 迭代 | 主要改动 |
|---|---|
| 0 | `lib/sdk-bridge.js` → `lib/claude-backend.js`；新增 `lib/agent-backend.js`（接口约定）；`lib/project.js`、`lib/sessions.js` 增加 backend 字段 |
| 1 | 新增 `lib/codex-backend.js`、`lib/codex-jsonrpc.js`；`lib/pages.js` 与前端 `modules/` 中 dashboard / new-project / project-header 三处 UI；新增"未登录引导"组件 |
| 2 | `lib/codex-backend.js` 接入权限；前端权限 Modal 加来源标签 |
| 3 | 后端能力声明协议；设置抽屉分发；隐藏不适用面板的开关 |
| 4 | 错误态组件、版本检查、日志面板 |
| 5 | Fork / skills / connectors UI |

---

## 当前下一步

**Iter 5b 完成。Iter 6 候选项待评估。**

5b 实施成果（应用了 5a 的所有教训）：
- protocol probe 先行（17/17）→ 提前发现"无 fork-point 锚点"，避免设计错误
- 单元测试 7 项（fake client 验证 RPC 翻译契约）
- WS e2e 6 项（真 daemon round-trip）
- UI e2e 13 项（Playwright DOM + WS 帧验证）
- **Live verify 真 Codex API 通过**：source 设 ALPHA → fork 记得 ALPHA → 切回 source 仍记得 ALPHA

总测试数：60 单元 + 32 WS e2e + 13 fork UI e2e + 22 hide UI + 25 unavailable UI + 8 approval UI + 25 generic UI + 8 auth-card = **193 全绿**。

---

**Iter 5a 历史回顾（保留作为踩坑记录）**：实施完后 live verify 证伪并撤回。Codex v2 协议不支持 modifyCommand-on-accept。所有改动 revert，基线恢复。Postmortem 见 Iter 5a KILLED 段。

5a 撤回原因：Codex v2 `CommandExecutionRequestApprovalResponse` 仅含 `decision` 字段，没有任何位置可以传修改后的命令。详细 postmortem 见 Iter 5a KILLED 段。所有 5a 代码改动已 revert，53 单元 + 8 approval e2e 基线恢复。

**5a 教训应用到 5b**（已完成）：
- ✅ thread/fork 实施前强制先跑 `scripts/codex-fork-protocol-probe.js` —— 17/17 全绿
- ✅ 实测发现"无 fork-point 锚点" → per-message UX 推 5c，5b 收敛为 HEAD-only
- ✅ 实测发现 `thread/resume { threadId }` round-trip 同 id —— 替代 plan 里的 hand-wavy "switchThread"
- ✅ 三层测试栈全建立：单元 + e2e + live verify
- ✅ live verify 跑通真 Codex API：source/fork/resumed-source 都记得 ALPHA

**Iter 2/3 实测后发现待跟进项**（部分聚到 Iter 4 已完成；剩余文档化）：
- `acceptForSession` 当前只缓存到 Clay 侧 `session.allowedTools[allowKey]`，重启 daemon 后丢失。Codex 进程内的会话 cache 也是同会话作用域，行为一致 — 但要在 Iter 4 错误处理里明确说明。
- 网络审批 (`networkApprovalContext`) 走的是同一 `commandExecution/requestApproval` 通道；UI 当前只展示命令文本，不区分 "命令" vs "命令+网络"。Iter 4 加 `networkAccess` 渲染时统一处理。
- Codex 设置（sandbox / approvalPolicy / model / effort）当前只存实例变量，daemon 重启丢失。如果用户期望持久化，Iter 4 加 daemon.json 字段；否则文档说明"重启即重置为 workspace-write + on-request"。
- `codex_config` echo 在 daemon 重启后不会重发首条，前端会显示默认值而非用户上次选择 — 同上。
