# MCP 服务器参考目录

> 记录所有已入库的 MCP 服务器配置和文档。**仅保存 README + 配置模板，不保存源码和 node_modules。**

---

## 📊 总览

| 分类 | 数量 | MCP 服务器 |
|------|------|-----------|
| data-storage | 5 | filesystem, sqlite, postgres, clickhouse, redis |
| network-browsing | 7 | fetch, puppeteer, puppeteer-server, chrome-devtools, firecrawl, playwright, scrapling |
| dev-collaboration | 3 | github, atlassian, gitmcp |
| reasoning-memory | 4 | memory, sequential-thinking, claude-mem, mem0 |
| devops | 6 | cloudflare, desktop-commander, docker, kubernetes, terraform, embedded-debugger-mcp |
| analytics | 2 | grafana, posthog |
| design | 1 | figma-context |
| security | 1 | semgrep |
| code-analysis | 2 | codegraph, context7 |
| productivity | 1 | notion-mcp |
| competition | 1 | kaggle-skill |
| agent-bus | 1 | agent-bus (BOOS 自研, Router Mode) |
| memory-kb | 1 | openviking (自建知识库，强制加载) |
| **合计** | **35** | |

---

## 各分类详情

### data-storage

| MCP | 启动方式 | 环境变量 | 文档 |
|-----|---------|---------|------|
| **filesystem** | `node dist/index.js <dir>` | — | `mcps/data-storage/filesystem/` |
| **sqlite** | `node dist/cli.js` | — | `mcps/data-storage/sqlite/` |
| **postgres** | npm: `@modelcontextprotocol/server-postgres` | `POSTGRES_CONNECTION_STRING` | `mcps/data-storage/postgres/` |
| **clickhouse** | Python (fastmcp) | — | `mcps/data-storage/clickhouse/` |
| **redis** | Node.js server | — | `mcps/data-storage/redis/` |

### network-browsing

| MCP | 启动方式 | 环境变量 | 文档 |
|-----|---------|---------|------|
| **fetch** | `node build/index.js` | — | `mcps/network-browsing/fetch/` |
| **puppeteer** | `MCP_TRANSPORT=stdio node dist/cli/index.js` | `MCP_TRANSPORT=stdio` | `mcps/network-browsing/puppeteer/` |
| **puppeteer-server** | `node dist/index.js` | — | `mcps/network-browsing/puppeteer-server/` |
| **chrome-devtools** | Node.js MCP | — | `mcps/network-browsing/chrome-devtools/` |
| **firecrawl** | Node.js MCP | — | `mcps/network-browsing/firecrawl/` |
| **playwright** | Node.js MCP | — | `mcps/network-browsing/playwright/` |
| **scrapling** | *(awaiting docs)* | — | — |

### dev-collaboration

| MCP | 启动方式 | 环境变量 | 文档 |
|-----|---------|---------|------|
| **github** | npm: `@modelcontextprotocol/server-github` | `GITHUB_TOKEN` | `mcps/dev-collaboration/github/` |
| **atlassian** | Python (SAM Lambda) | — | `mcps/dev-collaboration/atlassian/` |
| **gitmcp** | Node.js MCP | — | `mcps/dev-collaboration/gitmcp/` |

### reasoning-memory

| MCP | 启动方式 | 文档 |
|-----|---------|------|
| **memory** | `node dist/index.js` | `mcps/reasoning-memory/memory/` |
| **sequential-thinking** | npm: `@modelcontextprotocol/server-sequential-thinking` | `mcps/reasoning-memory/sequential-thinking/` |
| **claude-mem** | Claude Code Plugin | `mcps/reasoning-memory/claude-mem/` |
| **mem0** | Mem0 MCP Server | `mcps/reasoning-memory/mem0/` |

### devops

| MCP | 文档 |
|-----|------|
| **cloudflare** | `mcps/devops/cloudflare/` |
| **desktop-commander** | `mcps/devops/desktop-commander/` |
| **docker** | `mcps/devops/docker/` |
| **kubernetes** | *(awaiting docs)* |
| **terraform** | `mcps/devops/terraform/` |
| **embedded-debugger-mcp** | `mcps/devops/embedded-debugger-mcp/` |

### 其他

| 分类 | MCP | 文档 |
|------|-----|------|
| analytics | **grafana** | `mcps/analytics/grafana/` |
| analytics | **posthog** | *(awaiting docs)* |
| design | **figma-context** | *(awaiting docs)* |
| security | **semgrep** | `mcps/security/semgrep/` |
| code-analysis | **codegraph** | `mcps/code-analysis/codegraph/` |
| code-analysis | **context7** | `mcps/code-analysis/context7/` |
| productivity | **notion-mcp** | *(awaiting docs)* |
| competition | **kaggle-skill** | `mcps/competition/kaggle-skill/` |
| agent-bus | **agent-bus** (BOOS, Router Mode) | `mcps/agent-bus/` |
| memory-kb | **openviking** (强制加载) | `mcps/openviking/` |

---

## openviking — 使用规则（Sprint 42, 2026-08-06）

### 上下文检索优先级

| 问题类型 | 第一动作 |
|---------|---------|
| 跨会话/跨 agent（"上次谁处理过 X"、"Sprint N 决策依据"、某 UID/角色） | **`recall` 优先**，命中率 95%，再查文件 |
| 当前会话已注入的事实 | 直接用 CLAUDE.md / MEMORY.md |
| 任务内容 / 信件全文 | agent-bus `get_task_content` |
| recall 未命中 / 源码级细节 | 文件系统 / codegraph |

执行纪律: 每次决策最多 1 次 recall；`recall` 用具体名词+领域词做 query；`max_chars` 控制返回体积；只精读前 2-3 条。有值得跨会话保留的决策 → `remember`（提取异步，不阻塞）。

### 提取链状态（已修复）

- 根因: 07/26 配置变更后 vlm 段 `qwen-vl-plus` → LiteLLM 路由 dashscope provider → key 被拒（401），10 天零事件
- 修复: `ov.conf` vlm 段 = `anthropic/qwen3.7-plus` + `api_base=coding.dashscope.aliyuncs.com/apps/anthropic`（与 BOOS 共用 AI Coding 端点）
- 已验证: 事件落地 + recall 语义召回命中
- 仪表盘: `http://192.168.2.200:1933/studio/`

---

## agent-bus — Router Mode（Sprint 41）

**3 个恒定工具** 替代原来的 68 个全量工具:

| 工具 | 作用 |
|------|------|
| `check_inbox` | 非阻塞检查收件箱（无 wait 参数，事件驱动） |
| `agent_bus_list_tools` | 按需查完整 68 工具目录 / 单工具 schema |
| `agent_bus_call` | 调用任意 agent-bus 工具 `(tool_name, args)` |

**调用模式**: 先 `agent_bus_list_tools`（或按已知工具名取 schema）→ `agent_bus_call(tool_name, args)`。工具定义段恒定 → prompt cache 前缀稳定 → 缓存命中率 97.1%（Sprint 41 核心优化）。开关: `BOOS_MCP_ROUTER_MODE=1`（默认）/ `0`（传统全量工具面）。**不要**在无必要理由时改成 0。

> 完整指南: `AGENT-CONFIG-UPDATE-2026-08-06.md`（2026-08-06 · PM-A1）

---

## MCP 配置模板

```json
{
  "mcpServers": {
    "<name>": {
      "command": "node",
      "args": ["D:/AI IDE/CC_BOOS/HR/assets/mcps/<category>/<name>/<entry>"],
      "env": {
        "<KEY>": "<value>"
      }
    }
  }
}
```

---

*索引生成时间: 2026-07-17 · HR Agent*
