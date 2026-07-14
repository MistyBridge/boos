# Security Audit: /mcp/* 端点权限复查

**日期**: 2026-07-14  
**审计范围**: `lib/agentBus/transport.js` + `lib/middleware.js` + `server.js`  
**审计人**: 可靠性工程师  
**任务**: #83

---

## 架构概览

```
Browser (localhost / tunnel)
        │
        ▼
┌── Express Middleware Stack ──────────────────────┐
│  1. corsMiddleware      (Origin: GH Pages only)    │
│  2. createDeviceGate()  (/api/* only)             │
│  3. createHostOnlyGate()  (/mcp, /api/devices, /api/tunnel) │
├──────────────────────────────────────────────────┤
│  4. /mcp Router (transport.js)                    │
│     GET  /sse                                     │
│     GET  /sse/ccsm                                │
│     POST /message                                 │
│     POST /api/call                                │
│     GET  /health                                  │
└──────────────────────────────────────────────────┘
```

---

## Audit Checklist

### 1. CORS + Origin 校验

| # | 检查项 | 结果 | 说明 |
|---|--------|------|------|
| 1.1 | CORS 是否限制 origin | ✅ 通过 | 仅 `MistyBridge.github.io` 获得 CORS 头 |
| 1.2 | SSE 端点是否有独立 origin 校验 | ✅ 通过 | hostOnlyGate 限制 loopback-only，无需额外 CORS |
| 1.3 | `/mcp` 不与 `/api/*` CORS 策略冲突 | ✅ 通过 | `/mcp` 不在 `/api/*` 路径下，deviceGate 自动跳过 |
| 1.4 | 是否存在 `Access-Control-Allow-Origin: *` | ✅ 通过 | 未发现通配符 |

### 2. hostOnlyGate — 非 loopback 拦截

| # | 检查项 | 结果 | 说明 |
|---|--------|------|------|
| 2.1 | `/mcp` 是否在 HOST_ONLY_PREFIXES | ✅ 通过 | `middleware.js:22` |
| 2.2 | 是否检查 x-forwarded-for / x-forwarded-host | ✅ 通过 | `isDirectLoopback()` 检查代理头 |
| 2.3 | Tunnel 穿透绕过 hostOnlyGate | ✅ 通过 | CF/代理头 (`cf-connecting-ip`) 被阻断 |
| 2.4 | 中间件执行顺序正确 | ✅ 通过 | corsMiddleware → deviceGate → hostOnlyGate → Router |

### 3. 会话管理

| # | 检查项 | 结果 | 说明 |
|---|--------|------|------|
| 3.1 | sessionId 是否可预测 | ⚠️ 已知风险 | `/sse` 接受 `?sessionId=` 查询参数，无格式校验 |
| 3.2 | 会话是否自动过期 | ⚠️ 已知风险 | `SESSION_TTL_MS = Infinity`，永不超时 |
| 3.3 | 会话泄漏后能否劫持 | ⚠️ 已知风险 | 知道 sessionId 即可冒充该 agent 发 message |
| 3.4 | `/api/call` 创建新会话 | ⚠️ 已知风险 | 不存在 sessionId 时自动创建，可被用于生成任意会话 |

### 4. Agent 注册安全

| # | 检查项 | 结果 | 说明 |
|---|--------|------|------|
| 4.1 | 注册是否需要 token | ⚠️ 已知风险 | 无 token 认证，同一 localhost 上任何进程可注册 |
| 4.2 | 名称抢占 | ⚠️ 已知风险 | 同 workspace+name 返回相同 UID（幂等），恶意进程可抢占 |
| 4.3 | Workspace 隔离 | ✅ 通过 | 注册以 `(workspace, name)` 为 key，不同 workspace 隔离 |
| 4.4 | Role 权限模型 | ✅ 通过 | supervisor-only 工具在 handlers.js 中校验 role |

### 5. 输入校验

| # | 检查项 | 结果 | 说明 |
|---|--------|------|------|
| 5.1 | JSON body 大小限制 | ✅ 通过 | Express `express.json({ limit: '1mb' })` 全局生效 |
| 5.2 | method 参数校验 | ✅ 通过 | `/message` 拒绝空 method（200 + error event） |
| 5.3 | content 内容长度 | ✅ 通过 | `handlers.js` CONTENT_MAX_BYTES = 64KB |
| 5.4 | SSE 注入防护 | ✅ 通过 | SSE frame 使用 `JSON.stringify` 构造，`\n` 分割 |

### 6. 环境隔离

| # | 检查项 | 结果 | 说明 |
|---|--------|------|------|
| 6.1 | BOOS_NO_AGENT_BUS=1 彻底关闭 | ✅ 通过 | `server.js:111` 跳过 mount |
| 6.2 | 禁用后 /mcp 返回 404 | ✅ 通过 | Router 未挂载，Express 返回默认 404 |

### 7. 速率限制

| # | 检查项 | 结果 | 说明 |
|---|--------|------|------|
| 7.1 | SSE 连接数限制 | ❌ 需修复 | 无连接数上限，可被耗尽文件描述符 |
| 7.2 | `/message` 调用频率限制 | ❌ 需修复 | 无 per-session 或 per-IP 速率限制 |
| 7.3 | broadcast 频率限制 | ✅ 通过 | `handlers.js` 滑动窗口: 10次/分钟/agent |

### 8. 信息泄漏

| # | 检查项 | 结果 | 说明 |
|---|--------|------|------|
| 8.1 | `/health` 公开进程信息 | ⚠️ 已知风险 | 暴露 `pid`, `uptime`, `active_sessions`, `registered_agents` |
| 8.2 | 错误消息泄漏 | ⚠️ 已知风险 | `/message` 返回 `err.message`（line 249），可能含内部路径 |

---

## 汇总

| 级别 | 数量 |
|------|------|
| ✅ 通过 | 16 |
| ⚠️ 已知风险 | 7 |
| ❌ 需修复 | 2 |

### 已知风险（可接受，需文档化）

1. **sessionId 无格式校验** — 接受任意字符串，但攻击者需先突破 hostOnlyGate（loopback-only）
2. **session 永不过期** — `SESSION_TTL_MS = Infinity`，设计决策（agent 不应因闲置而断连）
3. **sessionId 劫持风险** — 知悉 sessionId 者可冒充，但仅限 localhost 环境
4. **`/api/call` 自动创建会话** — stdio bridge 兼容性设计
5. **无注册 token** — 设计决策：agent-bus 是内网组件，trust-on-first-use
6. **名称抢占** — 幂等注册是 feature（重连后恢复 UID），不是 bug
7. **`/health` 信息暴露** — hostOnlyGate 已限制 loopback

### 需修复

| 优先级 | 问题 | 建议 |
|--------|------|------|
| P1 | 无 SSE 连接数上限 | 添加 `MAX_SSE_CONNECTIONS`（建议 50），超过返回 503 |
| P1 | `/message` 无速率限制 | 添加 per-session 速率限制（建议 100 req/s） |
