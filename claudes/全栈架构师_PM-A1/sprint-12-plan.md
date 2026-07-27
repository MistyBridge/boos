# Sprint 12: Agent 硬约束引擎 + 决策区 UI 闭环

> 状态: 规划中 · 等待审核
> 日期: 2026-07-15

---

## 背景

当前 BOOS agent 团队有两个结构性缺口：

### 缺口 1: Agent 行为无代码层约束

PM 和其他 agent 的 CLAUDE.md 中写了行为规范（"不要问要不要继续"、"只在上报不可决策问题时暂停"），但这些是**纯文本指令**，没有代码层 enforcement。模型可能忽略这些指令，导致：

- 每完成一个子任务就问"要停止还是继续？"
- 遇到小障碍（如文件不存在、依赖版本模糊）就发起决策请求
- 大量决策请求淹没真正的关键决策

**目标**: 将行为约束从文本指令提升为代码层规则引擎。

### 缺口 2: 决策区无前端入口

当前决策区后端完整（`lib/decisionSystem.js` + `routes/decisions.js`），但前端：

- DecisionsPage 没有任何导航入口（sidebar 无链接、App.js 无路由）
- WorkspacePage 无决策区 badge/indicator
- 用户不知道有决策等待处理，除非 PM 手动告知
- 决策只能通过 API 查看，无 UI 交互界面

**目标**: 前端完整闭环——sidebar 入口 + 未决数量 badge + 决策卡片 UI。

---

## 需求拆解

### R15: Agent 硬约束引擎 (P0)

**设计原则**: 约束引擎不是"限制 agent 能力"，而是"消除无意义的交互摩擦"。引擎运行在 agent-bus 层，对所有 MCP 调用透明。

#### 约束规则表

| 规则 ID | 约束 | 代码层行为 | 触发条件 |
|---------|------|-----------|---------|
| C1 | 自动继续 | 拦截 `request_decision` 中的"是否继续"类内容 → 自动 approve | content 匹配 `/(继续|下一步|是否要|要不要|还要不要|接着)/` |
| C2 | 错误重试 | 前 2 次同类错误自动重试 → 不生成决策 | 同 agent + 同 task + 同 error_type 的 retry_count ≤ 2 |
| C3 | 清晰错误直修 | 错误信息包含明确修复路径 → 自动 apply 修复 → 不询问 | error message 匹配 `/(file not found|ENOENT|missing dependency|cannot find module)/` |
| C4 | 真正阻塞才上报 | 只有 force majeure 才进入决策区 | 不符合 C1-C3 的 request_decision → 正常入决策区 |
| C5 | 并发上限 | 单个 agent 最多同时处理 3 个 in_progress 任务 → 超出自动 defer | count(in_progress) ≥ 3 → 任务保持在 pending |
| C6 | 决策区通知静默期 | 同一 agent 10min 内最多上报 3 个决策 → 超出自动 merge | 10min 窗口内 >3 个 → 合并为一个"批量决策"卡片 |

#### 修改文件

| 文件 | 改动 |
|------|------|
| `lib/agentBus/constraints.js` (NEW) | 硬约束规则引擎 — `evaluate(action, context) → { pass, reason? }` |
| `lib/agentBus/handlers.js` | `_requestDecision` 调用 `constraints.evaluate()` 过滤自动可决的决策 |
| `lib/agentBus/notifications.js` | 约束触发时写入 PTY 日志（不阻塞 agent） |
| `lib/agentBus/decisionSystem.js` | 支持 merge 多个决策为批量卡片 |

#### 约束引擎 API

```js
const constraints = require('./constraints');

// 单个评估
const result = constraints.evaluate('request_decision', {
  content: '是否要继续实现下一步？',
  agent_uid: 'agent_xxx',
  task_id: 'task_yyy',
  retry_count: 1,
});
// → { pass: false, reason: 'C1: auto-continue — 此类确认无需人类决策', auto_action: 'reject' }

// 批量检查（并发上限）
const caps = constraints.checkLimits(agentUid);
// → { can_accept: false, reason: 'C5: 已达并发上限 (3/3)', pending_count: 3 }
```

---

### R16: 决策区前端入口 + UI 闭环 (P0)

#### 前端入口

| 位置 | 改动 |
|------|------|
| **Sidebar** | 新增 "Decisions" 导航项（带未决数量 badge） |
| **Sidebar badge** | 实时更新 `GET /api/decisions?status=open` 返回的数量 |
| **App.js** | 注册 `/decisions` 路由 + DecisionsPage 渲染 |

#### 决策卡片 UI（DecisionsPage 已有，但需增强）

| 功能 | 状态 | 说明 |
|------|:--:|------|
| 决策列表展示 | ✅ 已有 | 按时间倒序 |
| approve / reject 按钮 | ✅ 已有 | 一键回复 |
| 内联回复输入栏 | ✅ 已有 | Sprint 9 R2 |
| **导航入口** | ❌ 缺失 | Sidebar 无 Decisions 链接 |
| **未决数量 badge** | ❌ 缺失 | 用户不知道有决策等待 |
| **自动刷新** | ❌ 缺失 | 新决策到达时页面不刷新 |
| **批量决策 merge 卡片** | ❌ 缺失 | C6 产生的合并卡片无专用 UI |

#### 修改文件

| 文件 | 改动 |
|------|------|
| `public/js/components/Sidebar.js` | 新增 Decisions 导航项 + badge |
| `public/js/state.js` | 新增 `TAB_HEADINGS.decisions` |
| `public/js/App.js` | 注册 `/decisions` 路由 |
| `public/js/pages/DecisionsPage.js` | SSE 订阅 + 自动刷新 + 批量卡片 UI |
| `public/js/api.js` | 新增 `getDecisionCount()` 或复用 `checkDecisions()` |
| `public/css/sidebar.css` | badge 样式 |

#### UI 规格

```
Sidebar
├── 📋 Sessions         (现有)
├── 🚀 Launch           (现有)
├── ⚙️ Configure        (现有)
├── ℹ️ About            (现有)
└── 📝 Decisions  [3]   ← 新增, badge 红色圆点+数字
```

Badge 仅在计数 > 0 时显示。点击后 badge 不清零（用户可能查看但不处理），但提供 "全部已阅" 按钮。

---

### R17: 任务超时 24h + 单次通知归档 (P1)

> **已完成** ✅ — 见 `lib/agentBus/taskTimeout.js`
> 
> 改动：
> - TIMEOUT_MS: 30min → 24h
> - 超时后归档到 `~/.boos/archive/tasks/<yyyy-mm>/<id>.json`
> - 每个 task 只通知一次（`_notifiedOnce` Set 去重）
> - 可通过 task ID 在归档中回溯

---

### R18: sessionBinding fallback 实装验证 (P1)

> Sprint 6 修复的会话恢复 Bug（`lib/sessionBinding.js` detectClaude fallback）需要 BOOS 重启后才能生效。
> 重启 BOOS 并验证：`server.log` 中出现 `[boos] binding bound` 行。

---

## 任务分配

| # | 任务 | 负责人 | 优先级 | 估时 |
|---|------|--------|:--:|:--:|
| R15 | Agent 硬约束引擎 | PM (全栈) | P0 | 大 |
| R16a | 决策区 Sidebar 入口 + badge | 前端工程师 | P0 | 小 |
| R16b | 决策区 SSE 自动刷新 + 批量卡片 | 前端工程师 | P0 | 中 |
| R17 | 任务超时 24h 归档 | ✅ 已完成 | P1 | — |
| R18 | sessionBinding 重启验证 | PM | P1 | 小 |
| — | 全量测试回归 | 可靠性工程师 | P0 | 小 |

---

## 实施顺序

```
Wave 1 (并行): R15(PM·约束引擎) + R16a(前端·Sidebar入口)
Wave 2 (并行): R16b(前端·SSE刷新) + R18(PM·重启验证)
Wave 3 (收尾): 可靠性工程师·全量回归 + E2E 验证
```

R15 和 R16 无依赖，可完全并行。R16b 依赖 R16a（Sidebar 入口先做）。

---

## 验证计划

1. **C1 自动继续**: Agent 发起 "是否要继续" 决策 → constraints.evaluate 自动 reject → Agent 直接继续 → 决策区不产生新卡片
2. **C5 并发上限**: 给 agent 塞 4 个任务 → 第 4 个被 defer → 前 3 个完成后第 4 个自动进入
3. **C6 静默期 merge**: 同一 agent 10min 内上报 4 个决策 → 前 3 个单独卡片，第 4 个起合并
4. **R16 前端闭环**: Sidebar 显示 Decisions + badge [3] → 点击进入 → 看到 3 个待决卡片 → approve/reject 交互完整
5. **R17 超时归档**: 模拟 24h 老任务 → scanner 触发 → 归档文件存在 → agent-bus.json 中任务已 exhausted
6. **全量回归**: `node --test tests/*.test.js` → 全部 pass
