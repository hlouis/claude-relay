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
| 3-6 | 未开始 | — |

测试覆盖：单元 19/19 + WS e2e 9/9 + UI e2e 12/12 + Auth-card e2e 9/9 + Approval UI e2e 7/7 = **56/56 全绿**。

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

### Iteration 3 — 设置面板与模型切换

**目标**：Codex 项目可配置；UI 按后端渲染专属设置。

- AgentBackend 接口增加"声明支持哪些 setting key"的能力。
- 设置抽屉按后端分发：
  - Claude 区块：现状不变。
  - Codex 区块：model、reasoning effort、sandbox policy、approval policy。
- 顶栏 model chip 可点击切换 Codex 模型（`model/list`）。
- "API Key 覆盖"折叠区：在引导卡片下方暴露，存进项目 config，作为 `OPENAI_API_KEY` env 传给子进程。
- 不适用功能在 Codex 项目里**完全 hide**：
  - Rewind 按钮
  - Slash commands / Skills 面板（Claude 侧）
  - Hooks 面板（如有）

**完成标准**：用户能在 Codex 项目里切换模型与沙箱策略并立即生效（必要时下个 turn 生效）。

**不做**：Codex 原生 skills / connectors UI。

---

### Iteration 4 — 健壮性与错误处理

**目标**：把所有失败态体面化。

- `initialize` 阶段做版本兼容检查；不兼容显示阻断卡片 + `codex update` 提示。
- 运行中收到 401 / token 失效 → toast + 转回未登录引导。
- `codex app-server` 子进程崩溃 → 项目页全宽错误卡片 + Retry + View Logs。
- View Logs：surface `~/.codex/log/` 内最近一段（或我们自己捕获的 stderr 尾部）。
- Codex 二进制运行时被卸载（创建后才出问题）→ 友好降级。

**完成标准**：杀掉 codex 子进程、改 auth.json 让其失效、降级二进制版本，三种场景下用户都能从 UI 上理解发生了什么并恢复。

---

### Iteration 5 — Codex 原生特性

**目标**：暴露 Codex 独有能力，开始让 Codex 项目有自己的"质感"，不再只是"Claude 的影子"。

- **Thread Fork**：在消息流上提供 Codex 专属的 Fork 入口（不是把它伪装成 Rewind）。映射 `thread/fork`。
- **Skills**：拉 `skills/list`，在侧边栏给 Codex 项目独立 skills 面板。
- **Connectors / Apps**：`app/list`、MCP server 管理对接到设置面板。
- **Turn diff / plan**：如果 UI 价值明确，在消息流里渲染 `turn/diff/updated` 与 `turn/plan/updated`；否则继续翻译进现有消息流。
- **Command amendments**：权限 Modal 增加"修改命令"输入框（仅 Codex 命令审批时显示）。

**完成标准**：Codex 项目用户至少使用过 fork 或 skills 中的一个特性；该特性的 UI 不污染 Claude 项目。

---

### Iteration 6（Phase 2，可选 / 远期）

- **Clay 内 OAuth**：对接 `account/login/start`，让用户不离开 Clay 就能登录 Codex。仅当用户反馈强烈时做。
- **Compare Mode**：横向并排 Claude 与 Codex 项目，同一目录同一提示词对比输出。
- **共享 codex 进程**：如果性能/资源成为问题，可重新评估是否合并多项目到单个 codex 进程多 thread。当前默认每项目独立进程。

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

**进入 Iteration 3 — 设置面板与模型切换。**

具体抓手（待开工时再细化）：
1. AgentBackend 接口暴露"声明支持哪些 setting key"的能力。
2. 设置抽屉按后端分发：Claude 区块保持现状；Codex 区块加 model / reasoning effort / sandbox policy / approval policy。
3. 顶栏 model chip 可点击切换 Codex 模型（`model/list`）。
4. "API Key 覆盖"折叠区在引导卡片下方暴露，存项目 config 作为 `OPENAI_API_KEY` env 注入子进程。
5. 不适用功能在 Codex 项目里完全 hide：Rewind / Slash commands / Skills / Hooks。

**Iter 2 实测后发现待跟进项**（不阻塞 Iter 3）：
- `acceptForSession` 当前只缓存到 Clay 侧 `session.allowedTools[allowKey]`，重启 daemon 后丢失。Codex 进程内的会话 cache 也是同会话作用域，行为一致 — 但要在 Iter 4 错误处理里明确说明。
- 网络审批 (`networkApprovalContext`) 走的是同一 `commandExecution/requestApproval` 通道；UI 当前只展示命令文本，不区分 "命令" vs "命令+网络"。Iter 3 设置面板加 `networkAccess` 开关时再统一处理。
