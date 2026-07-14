# Sprint 8 — 全自動多 Agent 協作系統

> **目標**: 實現 agent-bus 的零人工干預閉環，引入 PM 身份系統和 HR Agent 自動招募
> **日期**: 2026-07-14 規劃 | **狀態**: 規劃中
> **前置**: Sprint 7 (#55 #56 #57) 完成

---

## 一、架構目標

```
Sprint 7 現狀:  任務內容送達 ✅  →  Agent 手動處理 → 手動 respond
                 ↓ (缺口: sender 不知道何時完成)

Sprint 8 目標:  PM 派活 → 自動送達 → 自動認領 → Agent 處理
                                    ↓
                雙向對話 ← → 完成自動通知 sender
                                    ↓
                鏈式觸發下一任務 → HR Agent 補充人手
```

---

## 二、Wave 分解

### Wave 1: PM 身份系統 (#70) — 基礎設施
> 耗時: 2-3 天 | 負責: 全棧架構師

```
當前:  workspace-level supervisor (扁平)
目標:  project-level PM (分層)

workspace "boos"
  ├── project "boos-core" → PM: 全棧架構師
  │   ├── 前端工程師
  │   └── 平台集成工程師
  ├── project "boos-ui" → PM: 前端工程師
  │   └── (招募中...)
  └── shared → HR Agent
```

**實現要點**:
1. agent schema: 增加 `project`, `pm_of` 字段
2. 權限: `send_task` / `list_agents` 限於同 project
3. `broadcast` 可選 scope: `project` | `workspace`
4. `set_pm(uid, projects[])` — supervisor 指派 PM
5. HR Agent 招募綁定 PM 的 project

**文件**: `lib/agentBus/store.js`, `registry.js`, `handlers.js`, `schemas.js`

---

### Wave 2: 通訊閉環 (#58 #59 #60) — 零人工干預
> 耗時: 3-4 天 | 負責: 全棧架構師 + 平台集成工程師

#### #58: 任務完成自動通知 sender (outbound notification)
```
修復前:
  Agent B: respond_task(taskId, result) → store.updateTaskStatus
  Agent A: (永遠不知道) → 手動 list_my_tasks

修復後:
  Agent B: respond_task(taskId, result)
    → queue.respondTask 觸發 outboxEvents
    → notifications.js 找到 sender PTY
    → 寫入: "[agent-bus] ✅ 平台集成工程師 完成 #55: 私有 API 重構已完成"
```

**文件**: `lib/agentBus/queue.js`, `lib/agentBus/notifications.js`

#### #59: 任務自動認領 — 送達即 in_progress
```
修復前:
  task → PTY 內容送達 (#52) → 狀態仍是 pending
  sender 看到 agent 已收到但無法確認

修復後:
  task → PTY 內容送達 → 自動 checkInbox(uid)
  → 狀態: pending → in_progress
  → PTY: "[agent-bus] 📨 任務已自動認領 #task_mrk..."
```

**文件**: `lib/agentBus/notifications.js`

#### #60: 雙向對話 reply_to
```
修復前:
  Agent B 對任務有疑問 → 發一個全新任務給 PM
  PM 收到: "這是回覆哪個任務的？"

修復後:
  Agent B: reply_task(parentTaskId, "這個需求不清楚，請確認...")
    → 新任務附帶 reply_to: parentTaskId
    → PM PTY 顯示: "[agent-bus] ↩️ 平台集成工程師 回覆 #55: ..."
    → 自動關聯，鏈式查詢
```

**文件**: `lib/agentBus/store.js` (reply_to), `queue.js`, `schemas.js`, `handlers.js`

---

### Wave 3: HR Agent (#65 #66) — 自動角色招募
> 耗時: 4-5 天 | 負責: 全棧架構師 + 平台集成工程師
> 依賴: #70 (PM 身份系統)

```
PM agent
  │ send_task("招募測試工程師", to="HR Agent")
  ▼
HR Agent (內嵌, 預設靜默)
  │ registry.json ── 角色模板 (從 D:\AI_Ex\HR\roles\)
  │ scanner.js ── D:\AI_Ex\skill\ + D:\AI_Ex\MCP\ + GitHub repos
  │ recruiter.js ── 生成 .mcp.json + CLAUDE.md + 約束
  ▼
新 Agent Session (測試工程師)
  │ project: PM 的 project
  │ capabilities: ["testing", "playwright", "e2e"]
  │ 約束: JD + 溝通協議 + 工作邊界
  ▼
workspace "boos" ── 團隊就位
```

**實現**:
1. `lib/hrAgent/registry.js` — 角色模板管理
2. `lib/hrAgent/recruiter.js` — agent 會話創建
3. `lib/hrAgent/scanner.js` — 資產發現
4. `lib/hrAgent/handler.js` — MCP 工具定義
5. `server.js` — 加載 hrAgent 模組 (類似 agent-bus 內嵌)
6. `#66`: Configure 頁面 HR Agent 設置區塊

**HR Agent 內嵌配置**:
- 位置: `lib/hrAgent/` (平行於 `lib/agentBus/`)
- 協議: MCP SSE (同 agent-bus 的 /mcp/sse)
- 註冊: auto-register as `{name: "HR Agent", role: "worker", capabilities: ["recruitment"]}`
- 靜默: 不參與輪詢，僅在被 `send_task` 時喚醒

---

### Wave 4: 完善自動化 (#61 #62 #63 #64)
> 耗時: 3-4 天 | 負責: 平台集成工程師 + 可靠性工程師

| # | 任務 | 說明 |
|---|------|------|
| 61 | 任務超時 | 30min pending/in_progress → timeout，通知雙方 |
| 62 | Agent 狀態 | idle/busy/offline，PM 可做負載決策 |
| 63 | 鏈式觸發 | Task A 完成 → 自動啟動 Task B (workflow engine) |
| 64 | 互喚增強 | wake_agent 附帶上下文 + wake_all |

---

### Wave 5: 體驗層 (#67 #68 #69)
> 耗時: 2-3 天 | 負責: 前端工程師 + 可靠性工程師

| # | 任務 | 說明 |
|---|------|------|
| 67 | 優先級隊列 | high priority 自動插隊 |
| 68 | 失敗重試 | retry_task + max 3 次 |
| 69 | 負載均衡 | round-robin / least-busy |

---

## 三、完整任務矩陣

| # | 任務 | Wave | 優先級 | 負責 | 依賴 |
|---|------|------|:--:|------|------|
| 70 | PM 身份系統 | 1 | 🔴 P0 | 全棧架構師 | — |
| 58 | 完成通知 sender | 2 | 🔴 P0 | 平台集成 | — |
| 59 | 自動認領 | 2 | 🔴 P0 | 平台集成 | #58 |
| 60 | 雙向對話 reply_to | 2 | 🔴 P0 | 平台集成 | — |
| 61 | 任務超時 | 4 | 🟡 P1 | 平台集成 | — |
| 62 | Agent 狀態 | 4 | 🟡 P1 | 平台集成 | — |
| 63 | 鏈式觸發 | 4 | 🟡 P1 | 全棧架構師 | #58 |
| 64 | 互喚增強 | 4 | 🟡 P1 | 平台集成 | — |
| 65 | HR Agent 招募 | 3 | 🟡 P1 | 全棧架構師 | #70 |
| 66 | HR 設置頁面 | 3 | 🟢 P2 | 前端工程師 | #65 |
| 67 | 優先級隊列 | 5 | 🟢 P2 | 平台集成 | — |
| 68 | 失敗重試 | 5 | 🟢 P2 | 平台集成 | — |
| 69 | 負載均衡 | 5 | 🟢 P2 | 平台集成 | #62 |

---

## 四、進度追蹤

| Wave | 狀態 | 開始 | 完成 | 測試 |
|------|:--:|------|------|:--:|
| Wave 1 (#70) | ⬜ 待開始 | — | — | — |
| Wave 2 (#58-60) | ⬜ 待開始 | — | — | — |
| Wave 3 (#65-66) | ⬜ 待開始 | — | — | — |
| Wave 4 (#61-64) | ⬜ 待開始 | — | — | — |
| Wave 5 (#67-69) | ⬜ 待開始 | — | — | — |

---

## 五、HR Agent 架構詳情

### 5.1 角色模板結構 (D:\AI_Ex\HR\roles\)

```json
{
  "test-engineer": {
    "name": "測試工程師",
    "capabilities": ["testing", "node-test", "playwright", "e2e", "coverage"],
    "skills": ["super-tdd", "super-verify", "debugging"],
    "mcps": ["filesystem", "github", "agent-bus"],
    "prompt": "你是 BOOS 項目的測試工程師...",
    "constraints": [
      "所有修復必須附帶單元測試",
      "不接受無測試覆蓋的代碼合入",
      "測試報告放在 claudes/測試工程師/ 目錄"
    ]
  }
}
```

### 5.2 資產掃描路徑

```
D:\AI_Ex\
  ├── HR\roles\          ← 角色模板
  ├── HR\templates\      ← CLAUDE.md 模板
  ├── skill\             ← 可用 skills
  ├── MCP\               ← 可用 MCP servers
  └── HR\registry.json   ← 角色註冊表

公共倉庫:
  github.com/anthropics/skills     ← Claude Code skills
  github.com/modelcontextprotocol/servers  ← MCP servers
```

### 5.3 招募流程

```
1. PM: send_task(to="HR Agent", content="招募測試工程師加入 project boos-core")
2. HR Agent: 被 inboxEvents 喚醒
3. HR Agent: registry.lookup("測試工程師") → 角色模板
4. HR Agent: scanner.collectAssets() → skills + MCPs
5. HR Agent: recruiter.createSession({
     role: "測試工程師",
     project: "boos-core",
     pm_uid: "agent_mrjzz7n7_6f12d5",
     skills: ["super-tdd", ...],
     mcps: ["filesystem", ...]
   })
6. HR Agent: respond_task(taskId, "已招募測試工程師 agent_xxx，workspace=boos")
7. PM: 收到通知，新工程師就位
```

### 5.4 Configure 頁面 UI

```
┌─ HR Agent ─────────────────────────────┐
│ [啟用] HR Agent 自動招募系統            │
│                                        │
│ 資產掃描路徑:                           │
│ ┌────────────────────────────────────┐ │
│ │ D:\AI_Ex  [✕]                     │ │
│ │ D:\Projects\assets  [✕]           │ │
│ │ [+ 添加路徑]                       │ │
│ └────────────────────────────────────┘ │
│                                        │
│ 公共倉庫:                               │
│ ┌────────────────────────────────────┐ │
│ │ github.com/anthropics/skills [✕]   │ │
│ │ [+ 添加倉庫]                       │ │
│ └────────────────────────────────────┘ │
│                                        │
│ 角色模板:                  [刷新]       │
│ ├─ 測試工程師 (test-engineer)          │
│ ├─ DevOps (devops-engineer)            │
│ └─ [+ 新增模板]                        │
│                                        │
│ 招募日誌 (最近 10 條):                  │
│ ├─ 07/14 16:30 招募 測試工程師 → OK    │
│ └─ 07/14 16:28 HR Agent 已啟動         │
└────────────────────────────────────────┘
```

---

## 六、風險與緩解

| 風險 | 影響 | 緩解 |
|------|------|------|
| PM 身份系統改動大 | agent-bus 兼容性 | 向後兼容：無 project 的 agent 預設為 legacy workspace 模式 |
| HR Agent 招募的 session 無法連接 agent-bus | 新 agent 孤立 | recruiter 自動生成正確的 .mcp.json |
| reply_to 鏈式嵌套過深 | 性能 | 限制最大嵌套深度 5 層 |
| D:\AI_Ex 資產變更 | 角色模板過時 | scanner 定期刷新緩存 (每小時) |

---

## 七、驗收標準

- [ ] PM 指派後，同 project agent 互相可見，跨 project 隔離
- [ ] 任務完成後 sender 3 秒內收到 PTY 通知
- [ ] 任務送達後 1 秒內自動轉為 in_progress
- [ ] reply_task 正確關聯父任務，list_my_tasks 顯示線程關係
- [ ] HR Agent 收到招募請求後 <30 秒創建新 session
- [ ] 新招募 agent 自動註冊到 agent-bus，加入正確 project
- [ ] 回歸測試: 現有 235+ 測試全綠
