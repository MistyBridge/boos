# Sprint 8 — Findings & Research

> 記錄 Sprint 8 實施過程中的發現、決策和技術調研結果

---

## 2026-07-14: 規劃階段發現

### F1: 當前 agent-bus 通訊缺口

追蹤完整任務生命週期後發現 5 個關鍵缺口：

| 步驟 | 狀態 | 缺口 |
|------|:--:|------|
| 派活 (send_task) | ✅ | — |
| 送達 (PTY write) | ✅ | #52 已修復 |
| 認領 (pending→in_progress) | ❌ | 需要手動 check_inbox |
| 執行中狀態回報 | ❌ | sender 無法知道進度 |
| 完成通知 | ❌ | sender 需手動查詢 |
| 雙向澄清 | ❌ | 無線程回覆機制 |

### F2: D:\AI_Ex 資產庫結構

```
D:\AI_Ex\
├── HR/
│   ├── roles/          ← JSON 角色模板
│   ├── templates/      ← CLAUDE.md 模板
│   ├── registry.json   ← 角色註冊表
│   ├── scripts/        ← 招募腳本
│   └── references/     ← 角色 JD 參考
├── skill/              ← 按領域分類的 skills
│   ├── backend/
│   ├── frontend/
│   ├── devops/
│   └── ...
├── MCP/                 ← MCP server 集合
│   ├── agent-bus/
│   ├── code-analysis/
│   └── ...
└── GUI/                 ← GUI 相關工具
```

### F3: workflow engine 現狀

`lib/agentBus/handlers.js` 已有:
- `_defineWorkflow` (L283) — 定義工作流
- `_addStage` (L290) — 添加階段
- `_addDependency` (L296) — 添加依賴
- `_activateWorkflow` (L302) — 激活工作流 (dispatchFn 模式)

但缺少:
- 工作流完成後自動觸發下一階段 (chain triggering)
- 工作流狀態查詢 API
- 工作流可視化

### F4: PM 身份系統對現有代碼的影響範圍

需要修改的文件:
- `lib/agentBus/store.js` — agent schema 加 project/pm_of
- `lib/agentBus/registry.js` — registerAgent 支援新參數
- `lib/agentBus/handlers.js` — 1 個新 handler (set_pm) + 權限檢查邏輯
- `lib/agentBus/schemas.js` — set_pm tool 定義
- `lib/agentBus/queue.js` — broadcast scope 過濾

向後兼容策略:
- 無 project 字段的 agent → 視為 legacy workspace 模式
- 無 pm_of 的 supervisor → 保持全局權限 (向後兼容)
