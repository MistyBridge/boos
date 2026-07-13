# Bugfix 验证报告

**验证日期**: 2026-07-13  
**审查人**: 可靠性工程师  
**来源**: Sprint 3 安全审查 P0 修复

---

## 修复 1: sessionId 可预测 → crypto.randomUUID()

**文件**: `lib/agentBus/transport.js:43`

**修复前**:
```javascript
function _generateSessionId() {
  return 'mcp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}
```

**修复后**:
```javascript
function _generateSessionId() {
  return 'mcp_' + require('node:crypto').randomUUID();
}
```

### 验证结果: ✅ 通过

| 检查项 | 结果 | 说明 |
|--------|------|------|
| `node --check` | ✅ 通过 | 无语法错误 |
| crypto.randomUUID() | ✅ 确认 | 密码学安全随机 UUID v4 |
| 唯一性 | ✅ 保证 | UUID 碰撞概率 < 10^-18 |
| 格式兼容 | ✅ | `mcp_` 前缀保留，下游解析不受影响 |

---

## 修复 2: SSE 端点无认证 → host-only gate

**文件**: `lib/middleware.js:22`

**修复前**:
```javascript
const HOST_ONLY_PREFIXES = ['/api/devices', '/api/tunnel'];
```

**修复后**:
```javascript
const HOST_ONLY_PREFIXES = ['/api/devices', '/api/tunnel', '/mcp'];
```

### 验证结果: ✅ 通过

| 检查项 | 结果 | 说明 |
|--------|------|------|
| `node --check` | ✅ 通过 | 无语法错误 |
| `/mcp` 已注册 | ✅ 确认 | L22 包含 `/mcp` |
| gate 逻辑正确 | ✅ 确认 | `createHostOnlyGate()` L90-91: `HOST_ONLY_PREFIXES.some(p => req.path.startsWith(p + '/'))` 匹配 `/mcp/sse`, `/mcp/message` 等 |
| loopback 豁免 | ✅ 确认 | `isDirectLoopback()` 豁免 localhost/127.0.0.1/[::1] |
| 外部请求拒绝 | ✅ | 非 loopback + 匹配 prefix → 403 `{ error: 'host-only endpoint' }` |
| `/api/devices/me` 豁免 | ✅ 保留 | L91: 特殊路径豁免不变 |
| E2E 测试未回归 | ✅ | 10/10 冒烟测试通过 |

**影响分析**: `/mcp/*` 端点现在仅允许 loopback 访问。这是合理的，因为 agent-bus MCP server 嵌入在 BOOS 进程中，agent 通过 localhost 连接。外部访问本来就不需要。

---

## 修复 3: idleWatcher 计数器未更新 → 同步检查

**文件**: `lib/idleWatcher.js`

**修复前**: 依赖外部模块调用 `setRunningCount()` 更新计数器（可能遗漏）

**修复后**: L51-55
```javascript
const hasRunningSession = (() => {
  try {
    return webTerminal.list().some((t) => !t.exitedAt);
  } catch { return false; }
})();
```

### 验证结果: ✅ 通过

| 检查项 | 结果 | 说明 |
|--------|------|------|
| `node --check` | ✅ 通过 | 无语法错误 |
| 直接调用 webTerminal.list() | ✅ 确认 | 每次 check 都同步查询，不依赖外部计数器 |
| 异常安全 | ✅ | try/catch 保护，webTerminal 异常时返回 false |
| filter 逻辑 | ✅ 正确 | `some(t => !t.exitedAt)` 检测任何未退出的 session |
| sessionCountCallback 桥接 | ✅ 保留 | transport.js L27-29 暴露 `setSessionCountCallback` 供 MCP 连接数统计 |

---

## 附带增强

`lib/agentBus/transport.js` 新增 session 计数回调 (L27-29):
```javascript
let _onSessionCountChange = null;
function setSessionCountCallback(cb) { _onSessionCountChange = cb; }
```
这使得 agent-bus 的活跃 MCP 连接数可以通过 `idleWatcher.setMcpConnectionCount()` 传递给 idleWatcher，完善了"活跃判断"的第三个条件。

---

## 总结

| 修复 | 状态 | 风险级别 |
|------|------|---------|
| crypto.randomUUID() | ✅ 验证通过 | P0 → 已解决 |
| host-only gate + /mcp | ✅ 验证通过 | P0 → 已解决 |
| idleWatcher 同步检查 | ✅ 验证通过 | P2 → 已解决 |

**所有 3 个修复正确实施，无回归。**
