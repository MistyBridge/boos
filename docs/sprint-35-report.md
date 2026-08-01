# Sprint 35 完成报告 & respond_task Bug 分析

> 前端工程师-A3 → 全栈架构师_PM-A1  
> 日期: 2026-08-01

---

## 一、Sprint 35 代码改动（已完成）

### Phase 1: DAG 仪表盘前后端联调 ✅

| 文件 | 改动 |
|------|------|
| `public/js/api.js` | 移除过时注释，确认 `fetchDagList/fetchDagStatus/approveDagTask/rejectDagTask` 对接 `routes/dags.js` 4 端点 |
| `routes/dags.js` | 无需改动 — 端点已注册 `server.js:282` |

### Phase 2: P1 修复 ✅

| # | 问题 | 文件 | 修复 |
|---|------|------|------|
| 1 | CSS `contain: strict` 高度塌陷 | `public/css/terminals.css:154` | `contain: strict` → `contain: layout style`（移除 `size` containment，flex 上下文中会导致高度塌陷为 0） |
| 2 | API 无统一超时 | `public/js/api.js` | `api()` 新增 30s 默认超时：`AbortController` + `setTimeout` + `finally { clearTimeout }`，AbortError → "请求超时 (30s)" |

> 注：PM 任务标注 `cards.css:224-228`，但该位置是 `.decisions-list`（无 `contain` 属性）。实际 `contain: strict` 在 `terminals.css:154` `.terminal-host-anchor`。

### Phase 3: 超标文件拆分 ✅

| 文件 | 改动前 | 改动后 |
|------|--------|--------|
| `ConfigurePage.js` | 1252 行 | **927 行** (-325, -26%) |
| `ConfigureWorkspaceSection.js` | — | **194 行** (新建) — `WorkspaceConfigSection` + `WorkspaceList` |
| `ConfigureHRAgentSection.js` | — | **125 行** (新建) — `HRAgentSection` + HR helpers |

### 测试

```
36/36 tests pass (frontend-util.test.js + frontend-backend.test.js)
```

---

## 二、respond_task Bug：无法回复任务

### 现象

两个任务（`task_msa58pmj_kocybs`、`task_msa5amka_ynf9cx`）反复出现：

1. `check_inbox` → 返回 `status: "in_progress"` ✅
2. `respond_task` → 报错 `"task is in status 'pending' — must be in_progress to respond"` ❌

循环 5+ 次，无法打破。

### 根因

`_respondTask` (handlers.js:353) 和 `claimPendingTaskAsync` (storeTasks.js:96) 使用不同的读取路径，存在写后读竞态：

| 函数 | 读取方式 | 锁 |
|------|----------|-----|
| `claimPendingTaskAsync` (check_inbox) | `withFileLock` → `_load()` 异步 | ✅ 有锁 |
| `_respondTask` 前置检查 | `store.getTask()` → `_syncLoad()` 同步 `readFileSync` | ❌ 无锁 |

流程：
```
check_inbox → claimPendingTaskAsync → withFileLock → _load() → status='in_progress' → _save(db) → 释放锁
                                                                                              ↓
respond_task → store.getTask(task_id) → _syncLoad() → readFileSync → 读到旧缓存 → status='pending' → 报错
```

`atomicWriteJson` 已做 fsync，但 Node.js `readFileSync` 在 Windows 上可能命中 OS 文件缓存，读到 fsync 前的旧内容。

### 修复建议

**方案 A（最小改动）**：`_respondTask` 中删除重复的同步校验，让 `queue.respondTask` 内部做完整的异步校验：

```js
// handlers.js _respondTask — 当前代码
async function _respondTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const task = store.getTask(args.task_id);  // ← 同步读，删掉这行
  if (!task) return { error: 'task not found' };  // ← 删掉
  const r = await queue.respondTask(args.task_id, ctx.uid, args.result, args.metadata);
  return r.ok ? { ok: true } : { error: r.error };
}
```

`queue.respondTask` 内部已有 `store.getTaskAsync(taskId)` (异步，queue.js:214)，且状态校验 `RESPONDABLE.has(task.status)` 逻辑完整。前置的 `store.getTask` 同步检查是冗余的，删掉即可。

**方案 B（更安全）**：改为 `store.getTaskAsync`：

```js
const task = await store.getTaskAsync(args.task_id);
```

---

## 三、当前状态

- Sprint 35 三个 Phase 代码全部完成 ✅
- 两个 agent-bus 任务因 respond_task bug 无法回复 ⚠️
- 建议 PM 或平台工程师修复 handlers.js `_respondTask` 同步读取问题
