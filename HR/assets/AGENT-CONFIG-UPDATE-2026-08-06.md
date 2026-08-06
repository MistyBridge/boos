# Agent 配置更新指南 — 2026-08-06

> **发起**: PM-A1 (全栈架构师) | **执行**: HR → 全部 agent
> **范围**: openviking 接入配置 + BOOS agent-bus 最新版 (Router Mode)
> **优先级**: 高 — 全部 agent 的配置知识需与本指南同步

---

## 1. openviking — 上下文召回系统

### 1.1 MCP 连接配置

服务器部署于 **Linux 192.168.2.200:1933**（非本机），HTTP MCP + API key 认证。

```json
"openviking": {
  "type": "http",
  "url": "http://192.168.2.200:1933/mcp",
  "headers": {
    "x-api-key": "<BOOS 团队 key — 见 D:\\AI IDE\\CC_BOOS\\.mcp.json>"
  }
}
```

**放置位置**: 项目根 `.mcp.json`（已在，无需重复）或各 agent 的 `.claude/settings.json` 的 `mcpServers`。已确认: 各 agent 的 `settings.json` 目前**没有** mcpServers 段 — 依赖项目级配置即可，无需逐个添加。

### 1.2 使用规则（新）— 上下文检索优先级

| 问题类型 | 第一动作 |
|---------|---------|
| 跨会话/跨 agent（"上次谁处理过 X"、"Sprint N 决策依据"、某 UID/角色） | **`recall` 优先**，命中率 95%，再查文件 |
| 当前会话已注入的事实 | 直接用 CLAUDE.md / MEMORY.md |
| 任务内容 / 信件全文 | agent-bus `get_task_content` |
| recall 未命中 / 源码级细节 | 文件系统 / codegraph |

执行纪律: 每次决策最多 1 次 recall；`recall` 用具体名词+领域词做 query；`max_chars` 控制返回体积；只精读前 2-3 条。有值得跨会话保留的决策 → `remember`（提取异步，不阻塞）。

### 1.3 提取链状态（已修复，无需 agent 操作）

- 根因: 07/26 配置变更后 vlm 段 `qwen-vl-plus` → LiteLLM 路由 dashscope provider → key 被拒（401），10 天零事件
- 修复: `ov.conf` vlm 段 = `anthropic/qwen3.7-plus` + `api_base=coding.dashscope.aliyuncs.com/apps/anthropic`（与 BOOS 共用 AI Coding 端点）
- 已验证: 事件落地 + recall 语义召回命中
- 仪表盘: `http://192.168.2.200:1933/studio/`

---

## 2. BOOS agent-bus — 最新版 (Router Mode, Sprint 41)

### 2.1 工具面形态（重要变更）

**3 个恒定工具** 替代原来的 68 个全量工具:

| 工具 | 作用 |
|------|------|
| `check_inbox` | 非阻塞检查收件箱（无 wait 参数，事件驱动） |
| `agent_bus_list_tools` | 按需查完整 68 工具目录 / 单工具 schema |
| `agent_bus_call` | 调用任意 agent-bus 工具 `(tool_name, args)` |

**调用模式**: 先 `agent_bus_list_tools`（或按已知工具名 `agent_bus_list_tools(tool_name)` 取 schema）→ `agent_bus_call(tool_name, args)`。

### 2.2 设计原因

工具定义段恒定 → prompt cache 前缀稳定 → 缓存命中率大幅提升（Sprint 41 核心优化，命中率 97.1%）。开关: `BOOS_MCP_ROUTER_MODE=1`（默认）/ `0`（传统全量工具面）。**不要**在无必要理由时改成 0。

### 2.3 协作规则（不变，需重申）

- `send_task` 后 BOOS 自动 `wake_agent`，无需手动唤醒
- 信件必须精简 — 长内容（>256 字符）自动外置到缓存文件，信件带摘要 + `content_ref`；收到"全文用 get_task_content 读取" → 调 `get_task_content(task_id, kind)` 取全文
- `check_inbox` 非阻塞、立即返回；禁止轮询/阻塞等待
- 修改 `lib/` 或 `server.js` 前 → `request_file_lock` → 改完 `release_file_lock`

---

## 3. HR 执行清单（为全部 agent 更新）

| # | 动作 | 目标 |
|---|------|------|
| 1 | 将本指南纳入 HR 资产索引（`assets/index.json`） | HR 知识库 |
| 2 | 同步更新 `assets/MCP_REFERENCE.md` 中 openviking 章节（使用规则 + 修复状态） | HR 知识库 |
| 3 | 确认各 agent 的 `.claude/CLAUDE.md` 或 `HR/` 播报含「openviking 优先召回」规则（可引用本指南 1.2 节） | 全部 agent |
| 4 | 确认各 agent 认识 Router Mode 三工具调用模式（2.1 节） | 全部 agent |
| 5 | 有活跃会话的 agent 建议执行一次验证: `openviking.health` + 一次 `recall` | 全部 agent |

**验证标准**: agent 能 `agent_bus_call` 调通工具、能 recall 召回本指南相关记忆（写入后 ~1 分钟内可召回）。

---

*生成: 2026-08-06 · PM-A1 | 关联: Sprint 41 Router Mode / openviking 提取链修复*
