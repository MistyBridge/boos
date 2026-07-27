# BOOS 前端优化方案建议 (Phase 2 — Sprint 26)

> 基于 Phase 1 架构概览的发现 · 调研日期: 2026-07-27

---

## 1. 状态管理

### 现状

Preact Signals (`@preact/signals@1.3.2`) 提供 30+ `signal()` + 4 个 `computed()`。组件直接 `.value` 读取，自动订阅。无 store/context 包装。

### 评估: **当前足够，暂不更换**

| 维度 | 评分 | 说明 |
|------|------|------|
| 细粒度响应 | ★★★★★ | 只重渲染读取该 signal 的组件 |
| 学习曲线 | ★★★★★ | 零模板代码，`.value` 读写 |
| 调试 | ★★★★☆ | 单文件 state.js，可 grep |
| 类型安全 | ★★☆☆☆ | 无类型推断 |
| 中间件/插件 | ★☆☆☆☆ | 无可拦截 signal 写入 |
| 时间旅行调试 | ☆☆☆☆☆ | 不支持 |

### 建议

1. **短期 (Sprint 26)**: 保持 Preact Signals。添加 `debugMode` signal → 开启时 console.log 所有 signal 写入
2. **中期 (Sprint 28)**: 为关键 signal 添加 JSDoc 类型注解 (`@type {{open: number, urgent: number, deferred: number}}`)
3. **长期**: 只有当出现以下任一需求时才考虑升级到 Zustand/Jotai:
   - 需要中间件(persist, devtools, immer)
   - 需要时间旅行调试
   - 跨 tab 状态同步
   - 团队规模 > 3 人需要显式 action 约束

### 不推荐引入 Redux/MobX

- Redux: 模板代码量远超收益
- MobX: Preact Signals 已覆盖其核心响应式能力

---

## 2. 错误边界

### 现状

- **无组件级错误边界。** 任何 render 阶段 throw → 整个 App 白屏
- `api()` 有 try-catch，但不覆盖渲染崩溃
- `pollHealth()` 有 3s timeout + 连续离线计数
- SSE 断连: EventSource 自动重连，`onerror` no-op
- WebSocket 断连: `TerminalInstance` 有递增延迟重连(最多 6 次)
- PTY 断开: `displaced` 状态显示"接管"UI

### 建议

#### 2.1 React Error Boundary (Preact 兼容)

Preact 支持 React Error Boundary 模式(`componentDidCatch`)。构建一个 class 包装器:

```js
// 建议新增: public/js/components/ErrorBoundary.js
class ErrorBoundary extends Component {
  componentDidCatch(err) {
    // 记录到 console + OpenViking
    // 显示降级 UI: "此组件加载出错，请刷新页面"
  }
}
```

**应用范围**: 包裹每个 `<Panel>` 层(整个页面级保护)

#### 2.2 API 超时统一策略

当前只有 `pollHealth` 有 3s AbortController 超时。建议为所有 `api()` 调用添加默认超时:

```js
// api.js 改进
const DEFAULT_TIMEOUT = 15_000;
export async function api(method, url, body, { timeout = DEFAULT_TIMEOUT } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(httpBase() + url, { ...opts, signal: ctrl.signal });
    // ...
  } finally { clearTimeout(timer); }
}
```

#### 2.3 SSE 重连指数退避

当前 SSE `onerror` 是 no-op，依赖 EventSource 内置重连。建议添加退避策略:

```js
let sseRetryDelay = 1000;
es.onerror = () => {
  sseRetryDelay = Math.min(sseRetryDelay * 2, 30_000);
  es.close();
  setTimeout(() => connectSSE(), sseRetryDelay);
};
es.onopen = () => { sseRetryDelay = 1000; };
```

---

## 3. 渲染性能

### 现状

| 优化点 | 已实现 |
|--------|--------|
| 终端 raw DOM(绕开 vDOM) | ✅ Sprint 18 P0 |
| CSS visibility tab 切换 | ✅ terminal-layer |
| GPU compositor layers | ✅ translateZ(0), will-change |
| `contain: strict/layout` | ✅ 多处 |
| SSE batch 50ms + rAF | ✅ Sprint 17 B1 |
| Signal 浅比较跳过写入 | ✅ Sprint 18 P2 |

### 3.1 终端 WebGL 纹理撕裂

**问题**: `scrollback: 2000` 是折衷。更大的 scrollback 值加剧 resize 时 WebGL atlas 重建撕裂。

**建议**:

1. **动态 scrollback**: 小窗口(< 80 cols) → scrollback=1000; 大窗口 → scrollback=5000
2. **ResizeObserver debounce**: resize → 等 150ms 用户停止拖拽后再 resize 终端, 避免中间状态触发多次 atlas 重建
3. **Atlas 预分配**: 在 resize 前 `clearTextureAtlas()`, resize 后 `forceRedraw()` — 代价是一次全屏闪烁, 但避免纹理撕裂

### 3.2 卡片列表重绘优化

DecisionPage/GoalPage 每 10s 刷新 + `clockTick` 每分钟变化 → 整个列表重渲染。

**建议**:

1. **列表级 key 策略**: 已使用 `key=${d.decision_id}`, Preact 正确 diff — 无需改动
2. **考虑虚拟列表**: 如果决策记录 > 100 条, 引入 `preact-virtual-list` 或手写 IntersectionObserver 懒渲染
3. **clockTick 优化**: 当前每个 DecisionCard 访问 `clockTick.value` 仅用于 `fmtAgo`, 可以改为只存 `lastMinute` 时间戳而非 signal

### 3.3 CSS 文件加载

16 个 `<link>` 加载 → 16 次 HTTP 请求。建议:

1. **开发环境**: 保持现状(便于调试)
2. **生产环境(GH Pages)**: 构建步骤合并 CSS → 1-2 个文件 + 压缩
3. 或使用 HTTP/2 Server Push (GH Pages 已支持 HTTP/2)

---

## 4. 缓存策略

### 现状

SW cache-first + `?v=1.1.0` 查询参数缓存爆破。`CACHE_NAME = 'boos-v3'`(从 v1 → v2 → v3 已迭代三次)。

### 问题

- Cache-first → 即使网络可用，也先返回缓存。新版本文件在旧 SW 控制下不可见
- `skipWaiting()` + `clients.claim()` 缓解，但用户可能需要在"下次页面加载"时才看到更新

### 建议

#### 方案 A: stale-while-revalidate (推荐)

```js
// 改为 stale-while-revalidate: 立即返回缓存，后台更新
event.respondWith(
  caches.open(CACHE_NAME).then((cache) =>
    cache.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((response) => {
        if (response?.ok && response.type === 'basic') {
          cache.put(event.request, response.clone());
        }
        return response;
      });
      // 返回缓存(如存在), 否则网络
      return cached || fetchPromise;
    })
  )
);
```

好处:
- 离线可用 (上次的缓存)
- 在线时总是看到最新版本(从第二次加载开始)
- 首次加载不阻塞 UI

#### 方案 B: network-first (备选)

```js
// 网络优先, 失败时回退缓存
// 适合"数据必须最新"的场景, 但失去离线加速
```

**推荐方案 A**。

---

## 5. CSS 架构

### 现状

16 个 CSS 文件，按功能域分割。Design Tokens 体系通过 CSS Custom Properties 实现。

### 评估: **架构合理, 优化方向是构建 toolchain**

| 维度 | 评分 | 说明 |
|------|------|------|
| 组织 | ★★★★☆ | 按功能域清晰分割 |
| 一致性 | ★★★★★ | tokens.css 驱动全局一致性 |
| 维护性 | ★★★★☆ | 改 token 自动传播 |
| 加载 | ★★☆☆☆ | 16 个文件, 无 bundling |
| 隔离 | ★★★☆☆ | 无 CSS Modules, 依赖命名约定 |

### 建议

1. **不引入 Tailwind**: Design Tokens + CSS Custom Properties 已覆盖 Tailwind 的核心价值(设计一致性)。Tailwind 会引入构建步骤 + 增加模板中的 class 噪音
2. **不引入 CSS Modules**: 需要构建工具链 — 当前项目刻意避免 build step
3. **推荐轻量方案**:
   - 引入 PostCSS (仅 `postcss-import` + `cssnano`) → 合并 + 压缩 CSS 到 1 个文件
   - 保持 tokens.css → base.css → ... 的手写组织方式
   - 发布时合并, 开发时保持分别引入

### Dark mode 覆盖策略

当前 `dark.css` 末尾加载，通过 `[data-theme="dark"]` 选择器覆盖。这是正确的做法 — 比 CSS 变量切换更直接(不需要为每个组件写 var()), 且浏览器可以缓存一份 CSS。

---

## 6. 测试覆盖

### 现状: **零测试**

- 无 `*.test.js` 文件
- 无 Playwright/Cypress E2E 脚本
- 无视觉回归测试

### 建议优先级

| 优先级 | 类型 | 工具 | 覆盖范围 |
|--------|------|------|----------|
| P0 | E2E 冒烟 | Playwright (已有 MCP) | 5 条核心路径 |
| P1 | 单元测试(工具函数) | Node test runner | util.js, i18n.js, state.js |
| P2 | 组件测试 | Preact testing library | Dialog, Toast, Card |
| P3 | 视觉回归 | Playwright screenshots | 所有页面截图 diff |

#### E2E 冒烟测试 (P0) — 5 条核心路径

1. **健康检查**: 访问 localhost:7777 → 确认页面加载, 侧边栏可见
2. **启动会话**: Launch 页 → 选择 CLI → 点击 Launch → 确认终端出现
3. **决策审批**: Decisions 页 → 点击 Approve → 确认 toast
4. **目标查看**: Goals 页 → 展开 GoalCard → 确认 tasks 显示
5. **侧边栏交互**: 切换文件夹展开/折叠 → 确认会话列表正确

#### 单元测试 (P1)

```js
// util.js
test('fmtAgo returns relative time', ...)
test('parseArgs handles double-quoted paths', ...)
test('parseArgs round-trips with formatArgs', ...)

// state.js
test('sessionsByFolder groups by folderId', ...)
test('pendingDecisionCount counts open decisions', ...)
```

---

## 7. 可观测性

### 现状: **无**

- 无前端错误上报
- 无性能监控
- 无用户行为分析 (也不应该收集 — BOOS 是本地工具)

### 建议

#### 7.1 错误收集

实现 `lib/errorReporter.js`:

```js
// 收集到 OpenViking (已有基础设施)
function reportError(err, context = {}) {
  const payload = {
    message: err.message,
    stack: err.stack,
    component: context.component || 'unknown',
    timestamp: Date.now(),
    userAgent: navigator.userAgent,
    boosVersion: document.querySelector('meta[name="boos-frontend-version"]')?.content,
    signals: {
      serverHealth: S.serverHealth.value?.state,
      sessionCount: S.sessions.value.length,
    },
  };
  // 写入 OpenViking
  // 同时 console.error 保留本地备份
}
```

集成点:
- `ErrorBoundary.componentDidCatch`
- `api()` catch 分支
- WebSocket `onerror`

#### 7.2 性能监控

轻量方案 — 只记录关键 metrics:

```js
// 在 main.js 启动末尾
const navEntry = performance.getEntriesByType('navigation')[0];
console.log('[boos] perf:', {
  domContentLoaded: navEntry?.domContentLoadedEventEnd,
  firstPaint: performance.getEntriesByType('paint')
    .find(e => e.name === 'first-contentful-paint')?.startTime,
  loadComplete: navEntry?.loadEventEnd,
});
```

#### 7.3 开发者工具增强

在 `debugMode` signal 开启时:
- 所有 API 请求计时
- Signal 写入日志
- xterm.js WebGL context loss 记录

---

## 8. 推荐优先级排序

| 优先级 | 项目 | 工作量 | 影响范围 | 风险 |
|--------|------|--------|----------|------|
| **P0-1** | 错误边界 (ErrorBoundary) | 0.5 天 | 全局稳定性 | 低 |
| **P0-2** | SW stale-while-revalidate | 1 天 | 用户体验 | 中 |
| **P0-3** | E2E 冒烟测试 5 条 | 1 天 | 回归防护 | 低 |
| **P1-1** | API 统一超时 | 0.5 天 | 网络容错 | 低 |
| **P1-2** | SSE 指数退避重连 | 0.5 天 | SSE 可靠性 | 低 |
| **P1-3** | 错误收集到 OpenViking | 1 天 | 可观测性 | 低 |
| **P2-1** | CSS bundling (PostCSS) | 1 天 | 加载性能 | 中 |
| **P2-2** | 单元测试 (util.js + state.js) | 1.5 天 | 代码质量 | 低 |
| **P2-3** | XtermTerminal 动态 scrollback | 0.5 天 | 终端体验 | 中 |
| **P2-4** | JSDoc 类型注解 | 1 天 | 可维护性 | 低 |
| **P3-1** | 组件测试 (Dialog, Toast) | 1.5 天 | 回归防护 | 低 |
| **P3-2** | 视觉回归测试 | 1 天 | UI 一致性 | 低 |

**总工作量估算**: P0 ~2.5 天, P1 ~2 天, P2 ~4 天, P3 ~2.5 天 = **总计约 11 天**

---

## 附录 A: 技术栈版本

| 依赖 | 版本 | 备注 |
|------|------|------|
| Preact | 10.27.0 | ESM.sh CDN |
| @preact/signals | 1.3.2 | 细粒度响应式 |
| htm | 3.1.1 | JSX-free 模板 |
| @xterm/xterm | 5.5.0 | 终端核心 |
| @xterm/addon-webgl | 0.18.0 | WebGL 渲染器 |
| @xterm/addon-fit | 0.10.0 | 自适应尺寸 |
| @xterm/addon-web-links | 0.11.0 | 链接检测 |
| @xterm/addon-clipboard | 0.1.0 | 剪贴板 |

## 附录 B: 文件行数统计

| 文件 | 行数 | 类型 |
|------|------|------|
| api.js | ~600 | 库 |
| main.js | ~260 | 入口 |
| state.js | ~280 | 状态 |
| Sidebar.js | ~550 | 组件 |
| XtermTerminal.js | 434 | 类 |
| TerminalView.js | ~170 | 组件 |
| SessionsPage.js | ~280 | 页面 |
| LaunchPage.js | ~280 | 页面 |
| DecisionPage.js | 153 | 页面 |
| GoalPage.js | 188 | 页面 |
| App.js | 140 | 路由 |
| 总计 (JS) | ~3,400 | — |
| 总计 (CSS) | ~3,500 | 16 文件 |
