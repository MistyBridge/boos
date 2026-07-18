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
| agent-bus | 1 | agent-bus (BOOS 自研) |
| **合计** | **34** | |

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
| agent-bus | **agent-bus** (BOOS) | `mcps/agent-bus/` |

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
