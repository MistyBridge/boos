# Agent-Bus MCP 连接稳定性审计报告

> **审计日期**: 2026-07-16 · **审计人**: 全栈架构师(PM)  
> **范围**: agent-bus MCP vs 标准 MCP (filesystem/github/memory/sequential-thinking)  
> **结论**: agent-bus 是唯一的**双跳网络代理型 MCP**，其他 4 个都是**本地直连 stdio 型**，架构差异导致 5 类独有故障模式

---

## 1. 架构对比 — 为什么 agent-bus 与其他 MCP 本质不同

### 标准 MCP：本地直连型（4 个都是这种）

```
┌──────────────────────────────────────────┐
│  Claude Code (CC)                        │
│    │                                     │
│    ├─ spawn: node <mcp-server>/index.js  │  ← 子进程
│    │    ├─ stdin  ← JSON-RPC 请求 (CC)   │
│    │    └─ stdout → JSON-RPC 响应 (CC)   │
│    │                                     │
│    └─ OS 管理生命周期                     │
│       • 进程退出 → CC 立刻感知 (EOF)      │
│       • 零网络依赖                        │
│       • 单跳: CC ↔ MCP Server            │
│       • CC 原生支持崩溃重启               │
└──────────────────────────────────────────┘
```

**特点**: 纯 IPC（管道），无网络栈，OS 内核管理，进程崩溃时 stdin/stdout 自动关闭 → CC 毫秒级感知。

### Agent-Bus MCP：双跳网络代理型（唯一的异类）

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code (CC)                                               │
│    │                                                            │
│    ├─ spawn: node mcp-proxy.js                                  │  ← 第 1 跳
│    │    ├─ stdin  ← JSON-RPC (CC)                               │
│    │    ├─ stdout → JSON-RPC (CC)  ← 从 SSE 收到后写入          │
│    │    │                                                       │
│    │    └── HTTP ──────────────────────┐                        │  ← 第 2 跳
│    │       GET  /mcp/sse  (长连接 SSE) │                        │
│    │       POST /mcp/message           │                        │
│    │                                   ▼                        │
│    │                          ┌──────────────────┐              │
│    │                          │ BOOS Express      │              │
│    │                          │  :7780            │              │
│    │                          │  /mcp/sse         │              │
│    │                          │  /mcp/message     │              │
│    │                          │  ┌─────────────┐  │              │
│    │                          │  │ agent-bus    │  │              │
│    │                          │  │ transport.js │  │              │
│    │                          │  │ queue.js     │  │              │
│    │                          │  │ store.js     │  │              │
│    │                          │  │ handlers.js  │  │              │
│    │                          │  └─────────────┘  │              │
│    │                          └──────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

**特点**: 中间代理 + 网络层 + 外部进程依赖。每一跳都是潜在故障点。

---

## 2. 故障模式分析 — 5 类独有失效路径

### 故障模式 #1：BOOS 服务器重启 → 全集群 MCP 断开 (P0)

| 属性 | 详情 |
|------|------|
| **触发条件** | BOOS 进程退出/重启（升级、崩溃、手动重启） |
| **影响范围** | 所有连接到该 BOOS 实例的 CC 会话（4+ agent） |
| **恢复方式** | 旧 proxy: `process.exit(1)` → **永久断开**；新 proxy: 2s 自动重试 SSE |
| **为什么其他 MCP 没这问题** | 它们不依赖外部进程，没有"服务器"会重启 |

**链路**:
```
BOOS 重启
  → SSE TCP 连接被 RST
  → proxy sseRes 触发 'end' 事件
  → 旧: process.exit(1) → CC 看到 MCP 子进程退出 → MCP 永久失效
  → 新: 2s 后 _connectSSE() 重连 → 但 CC 可能已判定 MCP 不可用
```

**现状**: 已修复 proxy 不再 exit，但 CC 侧的 MCP 超时机制**不等人** — proxy 重连 2s 很快，但 CC 在 MCP 初始化阶段有 10-30s 超时，超时后**不会再尝试重新初始化**该 MCP server。

### 故障模式 #2：CC MCP 初始化竞态 (P0)

| 属性 | 详情 |
|------|------|
| **触发条件** | CC 启动时 BOOS 尚未就绪，或 proxy 首次 `_connectSSE` 失败 |
| **影响范围** | 单个 CC 会话 — agent-bus 工具列表为空 |
| **恢复方式** | **无法恢复** — CC 不会重试已失败的 MCP 初始化 |

**时序**:
```
T=0    CC 启动，spawn mcp-proxy.js
T=0.1  proxy 读取 config.json → port 7780
T=0.2  proxy GET /mcp/sse → ECONNREFUSED (BOOS 未就绪)
       proxy 进入 auto-retry (2s 后重试)
T=10   CC MCP 初始化超时 → 标记 agent-bus 为 "failed"
       → 本 session 永不可用 agent-bus
T=10.2 proxy 重连成功 → 发送 initialize → 收到 tools/list
       → 写入 stdout: { tools: [...] }
       → CC 已忽略这个 MCP server 的后续输出
```

**根因**: CC 的 MCP 生命周期管理是"一次性"的 — 启动时尝试初始化，失败则放弃。proxy 的 auto-retry 虽然能恢复连接，但 CC 不会等它。

### 故障模式 #3：SSE 单向性 + 初始化握手脆弱 (P1)

| 属性 | 详情 |
|------|------|
| **触发条件** | SSE 连接在 `tools/list` 返回前断开 |
| **影响范围** | 单个 CC 会话 |
| **恢复方式** | proxy auto-retry 重连 → 但 CC 侧 initialize 已完成（失败） |

标准 MCP 初始化是严格的 request-response：
```
CC → stdin  → MCP: {"method":"initialize",...}
CC ← stdout ← MCP: {"result":{...}}
CC → stdin  → MCP: {"method":"notifications/initialized"}
CC → stdin  → MCP: {"method":"tools/list",...}
CC ← stdout ← MCP: {"result":{"tools":[...]}}
```

agent-bus proxy 的初始化：
```
proxy → POST /mcp/message → BOOS: {"method":"initialize",...}
proxy ← SSE ← BOOS: {"result":{...}}        ← 异步！依赖 SSE 连接存活
proxy ← stdout ← CC 收到 initialize result
proxy → POST /mcp/message → BOOS: {"method":"notifications/initialized"}
proxy → POST /mcp/message → BOOS: {"method":"tools/list",...}
proxy ← SSE ← BOOS: {"result":{"tools":[...]}}  ← 又一次依赖 SSE
```

如果 SSE 在任意一个 "← SSE ←" 步骤断开，该响应永远丢失。标准 MCP 的 stdin/stdout 是可靠的 FIFO 管道，不存在"异步丢帧"。

### 故障模式 #4：Session 亲和力断裂 (P1)

| 属性 | 详情 |
|------|------|
| **触发条件** | SSE 重连后 sessionId 变化；或 BOOS 重启后 `_sessions` Map 清空 |
| **影响范围** | agent 的 notifyAgent 无法投递 |
| **恢复方式** | agent 必须重新 `register_agent` + `check_inbox(wait=true)` |

**链路**:
```
BOOS 重启
  → _sessions Map = {} (内存清空)
  → proxy 重连获得新 sessionId: mcp_xxx_NEW
  → proxy POST /mcp/message?sessionId=mcp_xxx_NEW
  → transport.js: ctx.uid = null (新 session，无 register_agent 记录)
  → notifyAgent(uid) 遍历 _sessions 找不到匹配的 ctx.uid
  → wake_agent / task_available 通知投放失败
  → agent 的 check_inbox(wait=true) 永远不会解除阻塞
```

**现有缓解**: Sprint 17 新增了 `identity_by_mcp_session` 持久化索引 (store.js)，`notifyAgent` 有 Pass 2 fallback。但 `bindMcpSession` 只在 `tools/call` 时调用 — agent 必须先成功调用一个工具才能建立索引。如果重启后第一个操作就是 `wake_agent`，索引尚未建立。

### 故障模式 #5：网络栈开销 + 背压 (P2)

| 属性 | 详情 |
|------|------|
| **触发条件** | 高频 tool call（如批量 send_task） |
| **影响范围** | 延迟增大，可能触发 CC MCP 超时 |

**对比** (单次 `tools/call` 往返):

| 步骤 | 标准 MCP | agent-bus proxy |
|------|----------|----------------|
| CC → MCP | stdin write (内存拷贝, <1μs) | stdin write → proxy parse → HTTP POST → Express body parse → dispatch |
| MCP 处理 | 直接执行 | handlers.js → store.js (文件读写) → queue.js |
| MCP → CC | stdout write (<1μs) | dispatch result → SSE emit → proxy parse → stdout write |
| **总延迟** | **<1ms** | **5-50ms** (正常) / **100ms+** (文件 I/O 拥塞) |

agent-bus 的工具调用涉及 `agent-bus.json` 文件读写 (`store.js`)，高频操作时文件 I/O 成为瓶颈。

---

## 3. CC MCP 生命周期分析 — 核心约束

Claude Code 的 MCP 子进程管理有以下行为特征（来自观察和 MCP 规范）:

| 行为 | 影响 |
|------|------|
| 启动时 spawn 所有 MCP server | proxy 必须此时 BOOS 已就绪 |
| 30s 初始化超时 | proxy 必须在 30s 内完成 initialize + tools/list |
| MCP 崩溃后**不会自动重启** | proxy 的 auto-retry 对 CC 无意义（CC 已放弃） |
| MCP 子进程退出 → 从可用列表移除 | `process.exit()` = 永久断开 |
| 无 MCP 健康检查机制 | proxy 不能"通知"CC 它恢复了 |

---

## 4. 优化方案

### 方案 A: 直连模式 — 消除 proxy 跳 (推荐, 架构级)

将 agent-bus transport 改为**同时支持 stdio 模式**，让 CC 直接以 `command` 方式启动：

```json
// .mcp.json — 无需 proxy
"agent-bus": {
  "command": "node",
  "args": ["D:/AI IDE/CC_BOOS/lib/agentBus/stdio-bridge.js"],
  "env": {
    "BOOS_HOME": "C:/Users/admin/.boos"
  }
}
```

**stdio-bridge.js** — 新文件，直接读写 agent-bus.json，不经过网络：

```
CC spawn → stdio-bridge.js
  ├─ stdin  ← CC JSON-RPC
  ├─ stdout → CC JSON-RPC
  └─ 直接调用 store.js / queue.js / handlers.js (同进程内)
```

**优点**:
- 零网络依赖 → 消解故障模式 #1, #2, #3, #5
- 与标准 MCP 同架构 → 稳定性对齐
- 延迟 <1ms（内存 IPC vs HTTP 5-50ms）
- 不需要 BOOS 服务器在线

**缺点**:
- 跨进程共享 `agent-bus.json` → 需要已有的 `withFileLock` 机制（已实现）
- 不与 BOOS 前端 dashboard 直接交互 → 需要文件监听或定时同步（已有 SSE frontend 通知链）

**工作量**: ~150 行新文件 + 更新 `.mcp.json`

### 方案 B: Proxy 持久化 + CC 重连握手 (次选, 渐进式)

增强 mcp-proxy.js，使其能在 CC 判定失败后"重新握手"：

1. **Proxy 不退出** — 即使 SSE 断开，proxy 进程保持存活（已修）
2. **Proxy 缓存 tools/list** — 初始化成功后缓存 `tools` 定义，重连后立即返回，不等 SSE
3. **模拟 initialize 响应** — proxy 维护自己的初始化状态，CC 重新发送 initialize 时立即响应缓存值

```
CC → proxy stdin: {"method":"initialize",...}
proxy → CC stdout: {"result":{...}}  ← 缓存，立即返回（不等 SSE）
CC → proxy stdin: {"method":"tools/list",...}
proxy → CC stdout: {"result":{"tools":[...]}}  ← 缓存，立即返回
CC → proxy stdin: {"method":"tools/call","params":{"name":"register_agent",...}}
proxy → POST /mcp/message (正常转发)
proxy ← SSE ← result
proxy → CC stdout: result
```

**优点**: 不改变架构，只改 proxy 行为
**缺点**: tools/call 仍然需要网络 + BOOS 在线，核心故障模式未解决

**工作量**: ~50 行修改 `mcp-proxy.js`

### 方案 C: 健康检查 + 提前启动 (防御性)

1. **mcp-proxy.js 启动时轮询 BOOS 端口** — 在首次 SSE 连接前，先轮询 `/api/health` 直到 BOOS 就绪（最多等 15s），避免启动竞态
2. **CC 启动顺序保证** — BOOS 先启动，agent 会话后恢复（Sprint 17 C1/C2 已规划）

**优点**: 快赢，修复故障模式 #2
**缺点**: 治标不治本

**工作量**: ~10 行修改 `mcp-proxy.js`

### 方案 D: WebSocket 替代 SSE (远期)

将 agent-bus transport 从 SSE (单向) 改为 WebSocket (双向)：

```
proxy ←→ BOOS :7780 /mcp/ws (单个 WebSocket 连接)
  ← proxy → server: JSON-RPC request
  ← server → proxy: JSON-RPC response
```

**优点**: 全双工，不需要 SSE sessionId + POST message 分离
**缺点**: 大改 transport.js，现有 SSE 通知链需重构

**工作量**: ~300 行修改 `transport.js` + `mcp-proxy.js`

---

## 5. 推荐实施路径（触发制协作架构）

| 优先级 | 方案 | 效果 | 工作量 | 时间 |
|:--:|------|------|------|:--:|
| **P0** | Streamable HTTP 端点 (方案 E) | 触发信号走 HTTP response，消除 SSE 单点 | 100 行 | 3 h |
| **P1** | check_inbox 长轮询挂起 (方案 F) | 触发制核心 — 一次调用，任务到达即返回 | 50 行 | 2 h |
| **P2** | stdio-bridge 直连 (方案 A) | 终极方案 — 零网络，stdout 即触发信号 | 150 行 | Sprint 18 |

### 架构原则

```
触发制 ≠ 轮询

轮询: agent 反复调用 check_inbox(wait=false) → 即使无任务也占用网络/CPU
触发: agent 调用一次 check_inbox(wait=true) → BOOS 挂起响应 → 任务到达才返回

SSE 的失败在于：触发信号走独立通道（SSE），与请求-响应路径分离 → 通道断了触发就丢了
Streamable HTTP 的正确做法：触发信号嵌入 HTTP response → 响应不返回 = 等待触发 → 路径合一
```

### 实施顺序（全部服务于触发制）

**Step 1: Streamable HTTP 端点** — 建立触发信号与 HTTP response 的绑定  
**Step 2: check_inbox 长轮询** — 让触发信号在 response 中传递  
**Step 3: .mcp.json 切换 `type: "url"`** — CC 原生管理连接  
**Step 4: 删除 mcp-proxy.js** — 消除 proxy 故障域  
**Step 5: (远期) stdio-bridge** — 终极触发制，零网络

---

## 6. 模块化实施总结 (Sprint 17)

### 已完成的模块

#### M1: 任务队列 per-agent by uid ✅
**文件**: `lib/agentBus/queue.js`, `lib/agentBus/store.js`

**实现**:
- 添加 `listAllPendingQueues()` API — 返回所有有 pending 任务的 agent UID 列表
- 添加 `hasPendingTasks(uid)` API — 快速检查指定 agent 是否有 pending 任务
- 底层使用 `store.listAllPendingQueues()` 和 `store.countPendingTasks(uid)`

**验证**: ✅ 单元测试通过,API 返回正确结果

#### M2: 触发信号生成 (inboxEvents.emit) ✅
**文件**: `lib/agentBus/queue.js`

**现状**: 已实现
- 任务创建时自动 emit `task_available` 事件
- 事件 payload 包含 `receiver_uid`
- 支持批量发送和子任务拆分

**验证**: ✅ 事件触发正常,notifications.js 正确接收

#### M3: 触发信号订阅 (BOOS 侧) ✅
**文件**: `lib/agentBus/notifications.js`

**实现**:
- 维护 `_pendingQueues` Set — 跟踪有 pending 任务的 agent
- 添加 `checkAllQueues()` API — 扫描所有 agent 返回非空队列列表
- 添加 `hasPendingTasks(uid)` API — 检查指定 agent 状态
- `_onTaskAvailable` 中维护 pending 状态

**验证**: ✅ API 测试通过,状态跟踪正确

#### M4: 唤醒机制实现 ✅
**文件**: `lib/agentBus/notifications.js`

**实现**:
- 增强 PTY 唤醒信号格式 — 使用 ASCII 边框更醒目
- 添加详细日志记录 — SSE 投递状态、PTY 写入状态
- 清理 pending 状态 — 唤醒后从 `_pendingQueues` 移除
- 返回 `sse_delivered` 字段 — 告知调用方 SSE 是否成功

**关键改进**:
```javascript
// 增强的 PTY 唤醒信号
╔════════════════════════════════════════════════════════════╗
║  🔔 AGENT-BUS 唤醒信号 — 请立即执行 check_inbox(wait=false)  ║
╚════════════════════════════════════════════════════════════╝
您有 N 个待处理任务。
任务 ID: task_xxx, task_yyy
请调用: check_inbox(wait=false)
```

**验证**: ✅ 日志输出正常,信号格式更清晰

### 当前架构状态

```
触发链流程:
1. send_task → queue.js 存储任务
2. queue.js emit('task_available', receiver_uid)
3. notifications.js _onTaskAvailable 接收事件
4. _pendingQueues 更新,标记 agent 有待处理任务
5. wakeAgent() 被调用 → SSE + PTY 双通道唤醒
6. Agent 收到信号 → check_inbox(wait=false) → 处理任务
7. respond_task → 完成 → 状态重置
```

### 下一步: Streamable HTTP 实施 (P0)

**目标**: 消除 SSE 单点依赖,将触发信号嵌入 HTTP response

**实施计划**:
1. `transport.js` 新增 `POST /mcp` 端点 — Streamable HTTP 协议
2. 实现 `check_inbox(wait=true)` 挂起逻辑 — 任务到达时解除阻塞
3. `.mcp.json` 切换为 `type: "url"` — CC 原生管理连接
4. 删除 `mcp-proxy.js` — 消除 proxy 故障域

**预期效果**:
- 触发信号走 HTTP response → 不再依赖独立 SSE 通道
- CC 原生支持 → 无需 proxy 进程
- 故障域从 2 个减少到 1 个

**工作量**: ~150 行代码,预计 3-4 小时

---

## 6. 附件: MCP 连接状态快照 (2026-07-16 19:08 CST)

| MCP Server | 架构 | 传输 | 当前状态 |
|------------|------|------|:--:|
| filesystem | 本地直连 | stdio | ✅ 正常 |
| github | 本地直连 | stdio | ✅ 正常 |
| memory | 本地直连 | stdio | ✅ 正常 |
| sequential-thinking | 本地直连 | stdio | ✅ 正常 |
| **agent-bus** | **双跳网络代理** | **stdio → HTTP SSE** | ❌ 断开 |

BOOS Server: PID 39548, port 7780 ✅ 运行中  
SSE Endpoint: `http://localhost:7780/mcp/sse` ✅ 可访问  
mcp-proxy.js: 自动重连已修复 ✅  
CC session agent-bus MCP: ❌ 未初始化（启动竞态）

---

---

# 附录 A: 传输协议深度分析 — SSE vs 替代方案

> **核心发现**: 当前使用的 SSE (HTTP+SSE) 是 MCP 2024-11-05 的**已废弃**传输协议。  
> MCP 2025-03-26 已将其替换为 **Streamable HTTP**。  
> Claude Code 原生支持 `type: "url"` (Streamable HTTP)，**不需要 proxy 进程**。

---

## A.1 协议演进时间线

```
2024-11-05  MCP 初版: HTTP+SSE (当前 agent-bus 使用的)
2025-03-26  MCP 里程碑: SSE 废弃 → Streamable HTTP
2025-06-18  增强: SSE resumability + Origin 严格校验
2025-11-25  成熟: Last-Event-ID + session 安全加固
2026-07-28  未来草案: GET stream 端点移除, 无状态化
            ↑
            我们的 /mcp/sse (GET stream) 将不兼容
```

## A.2 SSE 协议自身的问题 (非网络层)

### A.2.1 文本协议解析开销

SSE 是一种**文本帧协议**，每帧包含元数据行：

```
event: message\ndata: {"jsonrpc":"2.0",...}\n\n
        ↑ 8 bytes overhead        ↑ 2 bytes terminator
```

每发送一条 JSON-RPC 消息，transport.js 的 `_sseEmit` 需要：
1. `JSON.stringify(jsonrpcMessage)` — 序列化
2. 字符串拼接 `'event: message\ndata: ' + data + '\n\n'` — 帧封装
3. `ctx.res.write(frame)` — HTTP chunked write

接收方 (proxy) 需要：
1. Buffer 累积 (`buf += chunk`)
2. 按 `\n\n` 分割帧
3. 逐行扫描 `data: ` 前缀
4. `JSON.parse(line.slice(6))` — 反序列化

**对比 WebSocket**: 直接二进制帧或文本帧，无前缀扫描。  
**对比 stdio**: 纯 `\n` 分隔的 JSON lines，零帧开销。

### A.2.2 单向性 + 双通道 Session 管理

```
┌─ SSE 通道 (server → proxy) ─┐     ┌─ POST 通道 (proxy → server) ─┐
│                              │     │                               │
│ GET /mcp/sse                 │     │ POST /mcp/message?sessionId=X │
│   → sessionId=mcp_xxx        │     │   body: JSON-RPC              │
│   → event: message           │     │   → 需要 query param 关联     │
│     data: <response>         │     │                               │
└──────────────────────────────┘     └───────────────────────────────┘
         同一个 sessionId 关联两条独立 TCP 连接
```

**问题**:
- SSE 断开 → sessionId 存在但无法接收响应
- POST 成功但 SSE 断开 → 响应发出但客户端收不到 (静默丢失)
- 重连获得新 sessionId → 旧的 POST 响应关联到已失效的 session

### A.2.3 背压处理不完整

`transport.js:102-106`:
```js
const ok = ctx.res.write(frame);
if (!ok) {
  ctx._drain = true;
  ctx.res.once('drain', () => { ctx._drain = false; });
}
```

设置了 `_drain` 标志但**从未使用它来阻塞后续写入**。如果 SSE 客户端消费慢：
- HTTP response buffer 无限增长
- 内存泄漏
- 最终 OOM 或 TCP 窗口耗尽

### A.2.4 Proxy 端信号缺失

CC 的 MCP 初始化序列依赖明确的请求-响应配对。SSE 的异步投递导致 proxy 无法区分：
- "BOOS 处理中" vs "SSE 响应丢失"
- "tools/list 未被调用" vs "tools/list 的 SSE 响应被丢弃"

proxy 当前**完全没有超时重试机制** — 如果 SSE 响应帧在传输中丢失（TCP 正常，SSE 解析丢帧），proxy 永久挂起。

---

## A.3 三种替代协议对比

### 对比矩阵

| 维度 | SSE + POST (当前) | WebSocket | Streamable HTTP | stdio |
|------|:--:|:--:|:--:|:--:|
| MCP 标准状态 | ❌ 废弃 (2024-11-05) | ⚠️ 非官方 | ✅ 当前标准 | ✅ 标准 |
| CC 原生支持 | ⚠️ `type: "sse"` | ⚠️ 有限 | ✅ `type: "url"` | ✅ `command` |
| 是否需要 proxy | ✅ 是 (mcp-proxy.js) | ✅ 是 | **❌ 否** | **❌ 否** |
| 双向通信 | 半双工 (双通道) | **全双工 (单连接)** | 半双工 (单端点) | **全双工 (管道)** |
| Session 管理 | sessionId query param | 连接即会话 | `Mcp-Session-Id` header | 进程即会话 |
| BOOS 重启恢复 | ⚠️ 需重连 + 重新初始化 | ⚠️ 需重连 + 重新初始化 | ⚠️ 需重连 + 重新初始化 | ❌ CC 进程也退出 |
| 每消息帧开销 | ~12 bytes (SSE 帧) | 2-6 bytes (ws frame header) | HTTP headers | 1 byte (\n) |
| 延迟 (本地) | 5-50ms | 2-20ms | 2-10ms | **<1ms** |
| 实现复杂度 | 已实现 | ~80 行 transport.js | ~100 行 transport.js | ~150 行 stdio-bridge.js |

### A.3.1 WebSocket 分析

**优点**:
- 单连接全双工 — 消除 sessionId 管理
- 原生 ping/pong (RFC 6455) — 连接健康检测无额外心跳代码
- 二进制帧支持 — 未来可传非 JSON 数据
- 浏览器端也可复用同一 ws 端点做前端通知

**缺点**:
- CC 的 WebSocket MCP 支持**不完整** — 部分版本仅支持 IDE 场景 (`ws-ide`)
- BOOS 重启 → TCP 断开 → CC 同样不会自动重连 MCP
- 仍需 proxy 进程（CC 不直接以 ws client 身份启动）
- 实现工作量: 在 transport.js 中新增 ws upgrade 处理 + proxy 用 ws 库重写

**结论**: WebSocket 优化了数据传输效率，但**不解决架构层面的 CC 重连问题**。proxy 仍然存在。

### A.3.2 Streamable HTTP 分析 ⭐ 推荐

**这是 MCP 2025-03-26 的官方标准传输**，也是 Claude Code **原生支持**的远程传输方式。

**CC 原生配置格式**:
```json
{
  "mcpServers": {
    "agent-bus": {
      "type": "url",
      "url": "http://localhost:7780/mcp"
    }
  }
}
```

**关键变化 — 消除 mcp-proxy.js**:

```
旧架构 (SSE):
  CC → spawn mcp-proxy.js → SSE/HTTP → BOOS :7780
       ^^^^^^^^^^^^^^^^^^^
       故障域 #1             故障域 #2

新架构 (Streamable HTTP):
  CC → HTTP POST/GET → BOOS :7780/mcp
       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
       单一故障域 (CC 原生管理)
```

**实施内容**:

1. **BOOS 侧**: 新增 `/mcp` 端点，实现 Streamable HTTP 协议：
   - `POST /mcp` — 接收 JSON-RPC (已基本实现在 `/mcp/message`)
   - `GET /mcp` — 返回 SSE stream 用于 server→client 通知 (已基本实现在 `/mcp/sse`)
   - `DELETE /mcp` — 终止 session
   - 响应 header 注入 `Mcp-Session-Id`
   
2. **`.mcp.json` 侧**: 从 `command: node mcp-proxy.js` 改为 `type: url, url: http://localhost:7780/mcp`

3. **删除**: `mcp-proxy.js` — 不再需要

**优点汇总**:
- ✅ CC 原生管理 MCP 连接生命周期（重连/超时/错误由 CC 处理，而非 proxy）
- ✅ 消除 mcp-proxy.js 进程 → 减少一个故障域
- ✅ 架构对齐标准 MCP → 与其他 `url` 型 MCP server 一致
- ✅ 跟随 MCP 规范演进 → 未来自动获得 `Last-Event-ID` 断点续传等能力
- ✅ Session 管理标准化 → `Mcp-Session-Id` header 替代自定义 query param

**工作量**: transport.js 新增约 100 行 (Streamable HTTP adapter)，修改 `.mcp.json` 约 5 行，删除 mcp-proxy.js。

### A.3.3 stdio 分析 ⭐ 最佳本地方案

**这是本地 MCP server 的标准方式**。CC 直接 spawn 进程，通过 stdin/stdout JSON-RPC 通信。

**实施内容**:

1. 新建 `lib/agentBus/stdio-bridge.js`：
   - 进程启动 → 直接连接 agent-bus store/queue/handlers (同进程内调用，零网络)
   - stdin 接收 JSON-RPC → 调用 `dispatch(toolName, args)` → stdout 返回
   - 通过 `queue.inboxEvents` + `fs.watch` 监听 `agent-bus.json` 实现 push 通知

2. `.mcp.json`:
```json
{
  "mcpServers": {
    "agent-bus": {
      "command": "node",
      "args": ["D:/AI IDE/CC_BOOS/lib/agentBus/stdio-bridge.js"],
      "env": {
        "BOOS_HOME": "C:/Users/admin/.boos"
      }
    }
  }
}
```

**优点汇总**:
- ✅ 零网络依赖 — 无需 BOOS 在线即可使用 agent-bus
- ✅ 延迟 <1ms — 同进程内函数调用，无序列化往返
- ✅ CC 原生生命周期 — 进程崩溃 CC 即刻感知并重启
- ✅ 与其他 4 个 MCP 架构完全一致
- ✅ 不依赖 MCP 网络传输规范演进

**缺点**:
- ⚠️ 多 CC 进程共享 `agent-bus.json` — 依赖已有的 `withFileLock` 机制
- ⚠️ 不与 BOOS 前端交互 — 需要使用 `fs.watch` 或定时轮询 `agent-bus.json` 来检测新任务

---

## A.4 推荐实施路径 (更新 — 触发制协作)

| 阶段 | 方案 | 效果 | 工作量 | 时间 |
|:--:|------|------|------|:--:|
| **Phase 1** | **Streamable HTTP 端点 + check_inbox 长轮询** | 消除 proxy，触发信号走 HTTP response | 150 行 | 4 h |
| **Phase 2** | .mcp.json 切换 `type: "url"` + 删除 proxy | CC 原生管理连接，零代理故障域 | 20 行 | 30 min |
| **Phase 3** (Sprint 18) | **stdio-bridge 直连** | 零网络，stdout 即触发信号 | 150 行 | 4 h |

### 原则：不引入轮询

所有阶段均基于触发制（事件驱动），不引入任何周期性轮询：
- `check_inbox(wait=true)` = 一次调用，BOOS 挂起直到任务到达才返回
- Streamable HTTP response = 触发信号载体
- stdio stdout = 终极触发信号载体

### Phase 2: Streamable HTTP 详细实施（触发制架构核心）

**背景**: CC 原生支持 `type: "url"`，我们让 BOOS 的 `/mcp` 端点符合 Streamable HTTP 规范，从而：
1. 消除 mcp-proxy.js 进程（消除故障域）
2. 将触发信号嵌入 HTTP response（消除独立 SSE 通道故障点）
3. 让 `check_inbox(wait=true)` 成为真正的挂起式触发调用

**改造文件**:

| 文件 | 变更 | 行数 |
|------|------|:--:|
| `lib/agentBus/transport.js` | 新增 `POST /mcp` handler + `DELETE /mcp` + `Mcp-Session-Id` header | +80 |
| `lib/agentBus/transport.js` | 现有 `GET /sse` → 重命名为 Streamable HTTP 兼容的 GET handler | ~20 |
| `.mcp.json` (4 files) | `command` → `type: "url"` | ~20 |
| `~/.boos/mcp-proxy.js` | 删除 | -122 |

**Streamable HTTP 端点设计**:

```javascript
// 统一端点: /mcp (替代 /mcp/sse + /mcp/message)
router.post('/mcp', async (req, res) => {
  // 1. 检查 Mcp-Session-Id header (非 initialize 请求必须带)
  // 2. 解析 JSON-RPC body
  // 3. 处理 initialize → 返回 result + Mcp-Session-Id header
  // 4. 处理 tools/call → 调用 dispatch()
  // 5. 可选: 返回 SSE stream (用于 server→client 异步通知)
});

router.get('/mcp', (req, res) => {
  // 用于 server→client 通知的可选 SSE stream
  // Last-Event-ID 支持断点续传
});

router.delete('/mcp', (req, res) => {
  // 客户端主动终止 session
});
```

**为什么这比 WebSocket 好**:
- 不需要 upgrade 握手 → 与现有 Express 中间件完全兼容
- 每个请求独立 → 无连接状态泄漏风险
- CC 原生支持 → 无需 proxy 桥接
- MCP 官方标准 → 跟随规范演进

**为什么不直接用 stdio-bridge**:
- Streamable HTTP 可以让 BOOS 前端 dashboard 直接使用同一端点
- stdio-bridge 需要处理多进程并发写 `agent-bus.json`，实现更复杂
- Streamable HTTP 是更安全的渐进式迁移 — 先消除 proxy，再考虑消除网络

### Phase 3: stdio-bridge 后续

当 Streamable HTTP 稳定后，`stdio-bridge.js` 提供终极方案：
- 启动时从 BOOS 拉取 `agent-bus.json` 快照
- 操作通过 `withFileLock` 写入 agent-bus.json
- 通过 `fs.watch` 或 inotify 检测变化 → 推送通知
- BOOS 离线时仍然可用（agent 间仍然可以通信）

---

## A.5 总结

| | 当前 (SSE+proxy) | Phase 1 | Phase 2 (Streamable HTTP) | Phase 3 (stdio) |
|---|---|---|---|---|
| Proxy 进程 | ✅ 有 | ✅ 有 (缓存增强) | ❌ 无 | ❌ 无 |
| CC 原生支持 | ❌ | ❌ | ✅ `type: url` | ✅ `command` |
| 故障域数 | 2 | 2 | **1** | **1** |
| MCP 规范兼容 | ❌ 废弃 | ❌ 废弃 | ✅ 当前标准 | ✅ 标准 |
| 延迟 (本地) | 5-50ms | 5-50ms | 2-10ms | **<1ms** |
| BOOS 离线可用 | ❌ | ❌ | ❌ | ✅ |
| BOOS Dashboard 可用 | ✅ | ✅ | ✅ | ⚠️ 需同步 |

---

# 附录 B: 触发制协作架构分析

> **架构目标**: 事件触发制 agent 协作 — agent 间按需触发，无轮询。  
> **当前触发链**: `send_task → BOOS store → SSE notification → agent check_inbox 解除阻塞`  
> **核心矛盾**: 触发信号依赖不稳定的 SSE 长连接 → 触发失败 → agent 永远不响应。  
> **优化方向**: 让触发信号传输路径与 MCP 请求路径**合一**，消除 SSE 单点依赖。

---

## B.1 触发制 vs 轮询的本质区别

| 维度 | 轮询 | 触发制 (目标) |
|------|------|------|
| Agent 行为 | 周期性调用 `check_inbox(wait=false)` | 调用 `check_inbox(wait=true)` 一次，阻塞等待 |
| 网络流量 | 高频小请求（即使无任务） | 仅在任务到达时产生流量 |
| CPU 开销 | 持续消耗 | 零（阻塞在 OS socket wait） |
| 延迟 | ≤ 轮询间隔 | 即时（事件到达即解除） |
| Agent CLAUDE.md 复杂度 | 需 while loop + timeout | 单一阻塞调用 |
| 符合 MCP 语义 | 是（request-response） | **是** — `tools/call` 可以长时间返回 |

## B.2 当前触发链的故障模型

```
┌─ 发送方 agent ─┐     ┌─ BOOS server ──────┐     ┌─ 接收方 agent ─┐
│                │     │                     │     │                │
│ send_task(...) │────→│ store.js: 写 json   │     │                │
│                │     │ queue.js: 标记 pending│    │                │
│                │     │ EventEmitter:         │    │                │
│                │     │   emit('task_avail')  │    │                │
│                │     │        ↓              │    │                │
│                │     │ transport.js:          │    │                │
│                │     │   notifyAgent(uid)    │    │                │
│                │     │        ↓              │    │                │
│                │     │ _sseEmit(ctx, ...)    │───→│ [SSE 长连接]    │
│                │     │        ↓              │    │   断开!         │
│                │     │ [触发信号丢失]         │    │   ↓            │
│                │     │                     │    │ agent 永远     │
│                │     │                     │    │  不响应        │
└────────────────┘     └─────────────────────┘     └────────────────┘
```

**故障点清单**:

| # | 故障点 | 触发条件 | 当前缓解 |
|:--:|--------|----------|----------|
| 1 | SSE 连接断开 | BOOS 重启 / TCP 超时 / proxy 退出 | 旧: process.exit; 新: 2s 重连 |
| 2 | SSE 重连后 sessionId 变化 | 故障 1 触发后 | 新: identity_by_mcp_session 索引 |
| 3 | _sessions Map 内存清空 | BOOS 重启 | 新: 持久化索引 fallback |
| 4 | proxy 进程初始化失败 | CC 启动时 BOOS 未就绪 | 无 |
| 5 | tools/call 返回后 agent 不调用 respond_task | CC 模型行为 | 后端 auto-acknowledge |

## B.3 触发制协作的理想架构

```
┌─ 发送方 agent ─┐     ┌─ BOOS server ────────────────┐     ┌─ 接收方 agent ─┐
│                │     │                               │     │                │
│ send_task(...) │────→│ store.js: 写 agent-bus.json   │     │                │
│                │     │ queue.js: emit('task_avail')   │    │                │
│                │     │        ↓                       │    │                │
│                │     │ check_inbox handler:           │    │                │
│                │     │   发现任务 → 直接返回 result    │    │                │
│                │     │   无任务 → 挂起 response,      │    │                │
│                │     │            等待 task_avail     │    │                │
│                │     │        ↓                       │    │                │
│                │     │ 任务到达 → 解除挂起 → 返回      │───→│ CC 收到 result  │
│                │     │                               │    │ → 开始处理     │
│                │     │                               │    │ → respond_task │
└────────────────┘     └───────────────────────────────┘     └────────────────┘
```

**关键设计**: `check_inbox(wait=true)` 是一个**挂起式长轮询**（long-poll）：
- BOOS 收到 tools/call → 不立即返回 → 等待 queue 中有任务 → 有任务后返回 JSON-RPC result
- 这**不是轮询** — agent 只发一次 call，BOOS 挂起直到触发条件满足
- HTTP response 本身就是触发信号载体 — 不依赖独立的 SSE 推送通道

**这与 Streamable HTTP 完美契合**：
- `POST /mcp` 返回 `Content-Type: text/event-stream` → 服务端在响应中推送事件
- check_inbox 的 response 就是 SSE stream 中的一帧
- 触发信号与请求-响应路径**合一** → 消除独立 SSE 通道故障点

## B.4 触发制稳定性保障：三层防线

### 第一层：连接存活

| 措施 | 效果 |
|------|------|
| Streamable HTTP (消除独立 SSE 通道) | 触发信号走 HTTP response，与请求路径合一 |
| TCP keepalive + NoDelay | 连接空闲不超时 |
| CC 原生 HTTP 连接池管理 | CC 自行处理 HTTP 重连 |

### 第二层：触发信号不丢失

| 措施 | 效果 |
|------|------|
| queue 持久化 (agent-bus.json) | 任务在磁盘上，不会因断连丢失 |
| check_inbox 长轮询 | agent 阻塞等待 → 任务到达时 response 立即返回 |
| 任务超时回收 | 120s 未处理的任务回退 pending → 其他 agent 可拾取 |
| 重连后重新 check_inbox | agent 重连后调用一次 → 拾取所有累积的 pending 任务 |

### 第三层：触发链降级恢复

| 措施 | 效果 |
|------|------|
| Streamable HTTP session 管理 | `Mcp-Session-Id` header 标准化，CC 自动处理 session 过期 |
| 重连后 register_agent 重建 ctx.uid | notifyAgent 能找到对应 session |
| stale task reclaimer | 即使触发信号丢失，超时任务自动恢复 |

## B.5 协议选择：触发制最优解

| 协议 | 触发信号路径 | 与触发制契合度 |
|------|------------|:--:|
| SSE + POST (当前) | 独立 SSE 通道推送 | ❌ 单点故障 |
| WebSocket | 全双工通道推送 | ⚠️ 可用但 proxy 仍存 |
| **Streamable HTTP** | **HTTP response 中嵌入触发** | **✅ 路径合一** |
| **stdio** | **stdout 推送** | **✅ 路径合一** |

### 结论：Streamable HTTP 是触发制的自然载体

**原因**:
1. Streamable HTTP 允许 `POST /mcp` 返回 `Content-Type: text/event-stream` → 即一个 HTTP 响应可以携带多个事件
2. `check_inbox(wait=true)` 可以直接利用这个特性：BOOS 挂起 HTTP response，任务到达时写入一帧 SSE 事件 → 关闭 stream
3. **触发信号 = HTTP response 的一部分** → 不依赖额外通道
4. CC 原生支持 → 无需 proxy 进程 → 减少一个故障域
5. 符合 MCP 2025-03-26 规范 → 跟随标准演进

```javascript
// BOOS 端 check_inbox handler (Streamable HTTP)
router.post('/mcp', async (req, res) => {
  if (method === 'tools/call' && params.name === 'check_inbox') {
    const tasks = await queue.getTasksForAgent(uid, 'pending');
    if (tasks.length > 0) {
      // 立即返回（触发信号已在 response 中）
      return res.json({ jsonrpc: '2.0', id, result: { tasks } });
    }
    if (args.wait) {
      // 挂起响应，等待任务到达
      const task = await new Promise(resolve => {
        const handler = (pendingUid) => {
          if (pendingUid === uid) {
            queue.inboxEvents.removeListener('task_available', handler);
            queue.getTasksForAgent(uid, 'pending').then(resolve);
          }
        };
        queue.inboxEvents.on('task_available', handler);
        // 超时兜底 (CC MCP 有 timeout，但这里也要防挂死)
        setTimeout(() => {
          queue.inboxEvents.removeListener('task_available', handler);
          resolve([]);
        }, 115_000); // 略低于 CC MCP timeout
      });
      return res.json({ jsonrpc: '2.0', id, result: { tasks: task } });
    }
    return res.json({ jsonrpc: '2.0', id, result: { tasks: [] } });
  }
});
```

## B.6 触发制与 Streamable HTTP 的融合设计

### 为什么 Streamable HTTP 是触发制的最佳载体

```
触发制工作流:

1. Agent A 调用 send_task (POST /mcp)
   → BOOS 存储到 agent-bus.json
   → EventEmitter emit('task_available', receiver_uid)
   → 返回 "ok" 给 Agent A

2. Agent B 的 check_inbox(wait=true) 正在挂起 (HTTP response 未返回)
   → BOOS 的 task_available listener 捕获事件
   → 检查 receiver_uid === Agent B 的 uid
   → 匹配 → 解除挂起，将 tasks 写入 HTTP response
   → Agent B 的 CC 收到 response → agent 开始处理

3. Agent B 调用 respond_task (POST /mcp)
   → BOOS 更新 task status
   → EventEmitter emit('task_completed', sender_uid)
   → Agent A 的 check_inbox 或 list_my_tasks 触发
```

**触发链完全在 HTTP request-response 语义内完成**，无需独立的推送通道。

### 与 SSE 对比

| | SSE 推送 (当前) | Streamable HTTP response 内嵌 |
|---|---|---|
| 触发信号载体 | 独立 SSE 长连接 | HTTP response 正文 |
| 连接数 | 2 (SSE + POST) | 1 (HTTP) |
| 触发信号丢失 | SSE 断开 = 永久丢失 | HTTP response 未返回 = 挂起等待 |
| 重连恢复 | 需要重新注册 + 重新绑定 session | CC 原生 HTTP 重连，重新 POST check_inbox |
| 代理进程 | mcp-proxy.js (故障域) | 无 (CC 直连) |

---

*报告结束 · 待 PM 审批后派发实施*
