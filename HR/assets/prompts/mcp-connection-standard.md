## MCP 连接规范

1. **双文件配置**: `settings.json` (enabledMcpjsonServers) + `.mcp.json` (mcpServers)
2. **settings.local.json**: 权限 allow 列表需包含全部 MCP tool 名称
3. **SSE-based MCP (如 agent-bus)**: type=sse, url=http://127.0.0.1:PORT/mcp/sse
4. **本地 MCP**: command=node, args 指向 `claudes/.mcp/<name>/dist/index.js`
5. **路径格式**: 使用正斜杠 `/`，Windows 盘符 `D:/`
6. **Skills 本地副本**: 从 `HR/assets/skills/` 复制到 `.claude/skills/`
