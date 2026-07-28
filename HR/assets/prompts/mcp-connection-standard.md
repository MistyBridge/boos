## MCP 连接规范

1. **双文件配置**: `settings.json` (enabledMcpjsonServers) + `.mcp.json` (mcpServers)
2. **settings.local.json**: 权限 allow 列表需包含全部 MCP tool 名称
3. **SSE-based MCP (如 agent-bus)**: type=sse, url=http://127.0.0.1:PORT/mcp/sse
4. **HTTP-based MCP (如 openviking)**: type=http, url + headers (x-api-key)
5. **本地 MCP**: command=node, args 指向 `claudes/.mcp/<name>/dist/index.js`
6. **路径格式**: 使用正斜杠 `/`，Windows 盘符 `D:/`
7. **Skills 本地副本**: 从 `HR/assets/skills/` 复制到 `.claude/skills/`
8. **OpenViking 强制加载**: 所有 Agent 入职时 `.mcp.json` 必须包含 openviking HTTP MCP；`settings.local.json` 的 `enabledMcpjsonServers` 必须包含 `"openviking"`，`permissions.allow` 必须包含 `"mcp__openviking__*"`
