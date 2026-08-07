# Sprint 42 Crash Investigation — Forensics Archive (2026-08-07)

> 本文档存档 BOOS 后端反复崩溃的完整调查过程与全部修复内容。
> 最终决策：**main 回退到 v1.2.0（可运行版本）**，本分支保存所有 Sprint 42 改动 + 崩溃修复尝试。

## 1. 崩溃症状

- 启动后 60-150s 内进程退出，`start.bat` 报 `[FAIL] BOOS failed to start`
- **无任何 JS 错误输出**：UNCAUGHT EXCEPTION / UNHANDLED REJECTION / shutdown 日志全部缺失
- 退出码 1，Windows 事件日志无 node.exe 崩溃记录（排除常规段错误）
- 崩溃点集中在：8 个 boot injection 之后、或 stale-reclaim / wakeAgent 密集期

## 2. 调查过程（按时间线）

| 阶段 | 动作 | 结论 |
|---|---|---|
| 1 | 复现崩溃（3 次，EXIT_CODE=1 无堆栈） | 原生层崩溃（非 JS 异常） |
| 2 | 检查 `storeAgents.js` migrateAgentUid | 修复 `inboxDir` 块级作用域泄漏（ReferenceError，被 catch，非崩溃源） |
| 3 | 检查 `notifications.js` HR Agent 注册 | 修复 `HR Agent registered: undefined`（_systemUid 支持） |
| 4 | Windows 事件日志查询 | 无 node.exe crash event → 排除经典 SEGFAULT |
| 5 | crash-marker 分析 | marker 停在 `pty-spawn command:'test'` → 发现 **tests/webTerminal.test.js 未隔离 BOOS_HOME**，污染真实 crash-marker |
| 6 | 隔离端口复现（7790，无 taskkill 干扰） | **仍崩溃** → 服务器自身问题，与测试/孤儿进程无关 |
| 7 | git 对比 v1.2.0 vs HEAD | 发现 Sprint 42 将 auto-resume 改为 **Promise.allSettled 并行 spawn** |
| 8 | 崩溃时序分析 | crash fallback 串行 spawn 6-8 个（每个 3-8s），boot injection setTimeout 在各自 spawn 后注册 → **首个注入 (T+8s) 触发时后续 spawn 仍在进行** → spawn+write 并发 → node-pty 原生崩溃 |

## 3. 根因结论

**node-pty（Windows ConPTY）并发原生操作崩溃**，两条触发路径：

1. **Sprint 42 引入的并行 auto-resume**（`serverLifecycle.js` manifest 路径 `Promise.allSettled`）— 多个 pty.spawn 并发
2. **boot injection 与后续 spawn 并发**（crash fallback 路径）：每个 spawn 完成后注册 `setTimeout(8000+i*400)`，但串行 spawn 耗时 3-8s/个，第一个注入触发时后面 spawn 还在跑 → **原生 spawn + write 同时进行** → 进程直接死（无 JS 堆栈，node-pty 原生层）

崩溃在原生层表现为：`pty.spawn()` 或 `pty.write()` 内部 ConPTY 竞争 → 进程 exit(1)，无异常可捕获。

## 4. 已实施的修复（本分支内容）

### 4.1 `lib/webTerminal.js` — write 全局串行队列
- 所有 `pty.write()` 走单一 promise 链（`_writeTail`），原生写永不并发
- 请求间 50ms 间隔（`BOOS_PTY_WRITE_GAP_MS` 可调）
- 浏览器 input（attach）也走串行队列
- **write 前 pid 存活探测**（`process.kill(pid, 0)`）— 防写死 PTY

### 4.2 `lib/sessionHelpers.js` — spawn 全局锁
- `_withSpawnLock()`：所有 `spawnSessionRecord` / `spawnSessionPickerRecord` 串行
- 锁覆盖：crash-reconnect、stale-reclaim auto-resume、用户手动 launch

### 4.3 `lib/serverLifecycle.js` — boot injection 后置
- crash fallback 的注入 setTimeout **全部在 spawn 循环结束后**统一注册（`spawnedIds.forEach`）
- 消除注入与后续 spawn 的并发窗口

### 4.4 `lib/agentBus/storeAgents.js` — migrateAgentUid 作用域修复
- `inboxDir` / `ib` 提升到函数级（两处 try 块共用），消除 `inboxDir is not defined` / `ib is not defined`

### 4.5 `lib/agentBus/registry.js` + `notifications.js` — HR Agent 注册
- `registerAgent` 支持 `_systemUid`（如 `agent_hr`）
- 已有同名卡复用（不迁移真实 Claude session uid）
- 修复 `HR Agent registered: undefined`

### 4.6 `server.js` — 崩溃取证
- 崩溃日志状态快照（livePTYs / port / uptime）
- `lib/crashForensics.js`：last-activity marker，`note()` 同步写盘（100ms 节流）
- 埋点：pty-spawn / pty-write / pty-ctrl-c / wakeAgent / queue-rebuild

### 4.7 `tests/webTerminal.test.js` — 测试隔离
- 设 `BOOS_HOME` 为临时目录（此前污染真实 crash-marker.json）

## 5. 验证结果

- 干净环境（无测试进程）：修复后曾 60-70s 存活（多次）
- 隔离端口复现：**修复后仍偶发崩溃**（stale-reclaim 7 tasks 触发后）
- 结论：修复降低并发概率，但未根治 — node-pty 在密集唤醒场景（stale-reclaim → 多 agent 同时 wake → 并发注入/spawn）下仍不稳

## 6. 回退决策

用户决策（2026-08-07）：**放弃当前版本，main 回退到 v1.2.0（可运行发布版）**。
本分支 `fix/sprint42-crash-attempt` 保存全部 Sprint 42 功能 + 崩溃修复，供后续低风险逐步合入。

## 7. 后续建议（回退后）

1. 在 v1.2.0 基础上**逐个**合入 Sprint 42 功能，每次合入后做启动稳定性验证（60s+ 观察）
2. 优先验证：SQLite 迁移（`--experimental-sqlite` 启动 flag 依赖 Node 22.5+）
3. node-pty 并发问题考虑：升级 node-pty、或 `useConptyDll=false`（已改）、或注入调度器（pacing）
4. 测试进程与服务器**禁止同机并发运行**（webTerminal.test.js 等 spawn 真实 PTY）

---

*存档时间: 2026-08-07 · 分支: fix/sprint42-crash-attempt · 基线: v1.2.0*
