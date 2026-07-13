# Agent-Bus 自动注入验证报告

> 平台集成工程师 | 2026-07-13 | Task 3

## 验证结论

✅ **Agent-Bus 已内嵌到 BOOS**，启动 session 时自动注入 `.mcp.json`。

---

## 一、架构变化

原先 Agent-Bus 是独立进程（`node agent-bus/server.js`，端口 7778），现已被内嵌：

```
之前: BOOS (:7777) ←→ Agent-Bus (:7778)  [两个进程，两个端口]
现在: BOOS (:7777) + /mcp/sse             [单一进程，内嵌 MCP]
```

代码位置：`server.js` L173-185

```js
// ── Embedded Agent-Bus MCP ─────────────────────────────────────────
if (process.env.BOOS_NO_AGENT_BUS !== '1') {
  try {
    const { createRouter } = require('./lib/agentBus/transport');
    app.use('/mcp', createRouter());
    console.log('[boos] agent-bus MCP mounted at /mcp/sse');
  } catch (e) {
    console.warn('[boos] agent-bus MCP failed to mount:', e.message);
  }
}
```

---

## 二、`.mcp.json` 自动注入验证

### 2.1 代码路径

`server.js` L1216-1243，位于 session launch 流程中：

```js
// Auto-inject agent-bus MCP config into the workspace so every
// agent launched through BOOS automatically gets collaboration
// tools (register_agent, send_task, check_inbox, etc.).
if (shouldLaunch) {
  const mcpPath = path.join(launchCwd, '.mcp.json');
  try {
    let existing = { mcpServers: {} };
    try {
      const raw = await require('node:fs/promises').readFile(mcpPath, 'utf-8');
      existing = JSON.parse(raw);
    } catch { /* no existing .mcp.json — start fresh */ }

    const merged = {
      ...existing,
      mcpServers: {
        ...(existing.mcpServers || {}),
        'agent-bus': {
          type: 'sse',
          url: `http://127.0.0.1:${currentPort}/mcp/sse`,
        },
      },
    };
    await require('node:fs/promises').mkdir(path.dirname(mcpPath), { recursive: true });
    await require('node:fs/promises').writeFile(mcpPath, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[boos] failed to auto-write .mcp.json:', e.message);
  }
}
```

### 2.2 注入行为

| 特性 | 行为 |
|------|------|
| **触发时机** | Session launch 时（`shouldLaunch = true`） |
| **写入位置** | `{launchCwd}/.mcp.json` |
| **合并策略** | 读取已有 `.mcp.json` → 追加 `agent-bus` 条目 → 写回 |
| **不会覆盖** | 已有 `mcpServers` 条目会被保留（spread 合并） |
| **URL 格式** | `http://127.0.0.1:{currentPort}/mcp/sse` |
| **type** | `sse`（MCP SSE transport） |

### 2.3 注入后的 `.mcp.json` 示例

```json
{
  "mcpServers": {
    "agent-bus": {
      "type": "sse",
      "url": "http://127.0.0.1:7777/mcp/sse"
    }
  }
}
```

---

## 三、当前 `.mcp` 目录结构

```
claudes/.mcp/
├── fetch/          ← MCP fetch server
├── filesystem/     ← MCP filesystem server
├── memory/         ← MCP memory server
├── playwright/     ← MCP Playwright server
├── package.json
└── node_modules/
```

这些是当前 Claude Code 工作区已安装的 MCP server，与 BOOS 自动注入的 `agent-bus` 条目互补。

---

## 四、验证检查表

| 检查项 | 状态 | 说明 |
|--------|------|------|
| Agent-Bus 内嵌到 BOOS | ✅ | `lib/agentBus/transport.js`，通过 `app.use('/mcp', ...)` 挂载 |
| SSE 端点路径 | ✅ | `/mcp/sse`（挂在 BOOS 端口 7777） |
| `.mcp.json` 自动注入 | ✅ | `server.js` L1221-1243 |
| 合并已有 MCP servers | ✅ | 使用 spread 合并，不覆盖已有条目 |
| 环境变量开关 | ✅ | `BOOS_NO_AGENT_BUS=1` 可禁用 |
| 错误处理 | ✅ | try/catch + console.warn，不阻断 session 启动 |
| URL 使用动态端口 | ✅ | `currentPort` 变量（支持端口漂移） |

---

## 五、与之前架构的差异

| 项 | 之前（外部 Agent-Bus） | 现在（内嵌） |
|----|------------------------|-------------|
| Agent-Bus 端口 | 7778（独立进程） | 7777（复用 BOOS 端口） |
| SSE 端点 | `http://127.0.0.1:7778/sse/ccsm` | `http://127.0.0.1:7777/mcp/sse` |
| agentBusWatcher 连接 | `http://127.0.0.1:7778/sse/boos` | 需更新为 `/mcp/sse` 端点 |
| 进程管理 | 需要 server.js 自动启动 | 随 BOOS 同生命周期 |
| 注册方式 | 独立 agent-bus 协议 | MCP SSE transport（标准协议） |

---

## 六、待办事项

- [ ] 更新 `agentBusWatcher.js` 的 `AGENT_BUS_SSE` URL：从 `http://127.0.0.1:7778/sse/boos` 改为 `http://127.0.0.1:7777/mcp/sse`
- [ ] 验证 watcher 能正确接收内嵌 agent-bus 的 SSE 事件
- [ ] 若 watcher 的 `/sse/ccsm` 端点不再存在，确认内嵌 agent-bus 有等效的消息广播机制

---

## 结论

Agent-Bus 已成功内嵌到 BOOS，`.mcp.json` 自动注入逻辑完整。唯一需要后续跟进的是 `agentBusWatcher.js` 的 SSE 端点 URL 对齐。
