## Agent 配置规范

1. **Skills 必须本地副本** — 从 `HR/assets/skills/` 复制到 `.claude/skills/`，不得仅引用外部路径
2. **嵌套 skills 需要显式路径** — 每个子集合在 settings.json 中独立配置路径
3. **MCP 双文件配置** — settings.json (enabledMcpjsonServers) + .mcp.json (mcpServers) 都要配置
4. **MCP 源文件本地副本含依赖** — 包含完整 node_modules 树
5. **路径精确** — 使用 `D:/AI IDE/CC_BOOS` 格式，不得混用 `\\` 或 `\`
6. **SSE-based MCP 需手动启动** — 如 agent-bus 不会自动启动，需在 BOOS 服务中预配置
