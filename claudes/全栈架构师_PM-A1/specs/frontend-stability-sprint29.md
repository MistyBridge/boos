# Sprint 29: 前端架构升级 — 根治稳定性问题

> PM: 全栈架构师_PM-A1 | 执行: 前端工程师-A3 | 日期: 2026-07-27
> 目标: 彻底消除 UI 花屏、撕裂、自动刷新的根源

---

## 背景

经全面排查，当前前端 Preact + Signals + xterm.js WebGL 架构存在 6 类根源问题：

| # | 问题 | 根因 | 严重度 |
|---|------|------|:--:|
| 1 | 侧边栏整树每 5s 重渲染 | `clockTick` signal 被每个 SessionRow 读取 | 🔴 |
| 2 | 终端花屏/闪烁 | xterm.js WebGL `clearTextureAtlas()` | 🔴 |
| 3 | WS 重连终端清屏 | `xterm.reset()` 销毁全部内容 | 🔴 |
| 4 | Agent 状态未批处理 | `handleAgentStatus` 跳过 50ms 防抖 | 🟡 |
| 5 | 侧边栏拖动撕裂 | CSS transition 期间每帧触发 xterm.resize() | 🟡 |
| 6 | 10+ 无限 CSS 动画 | 与 WebGL Canvas 争 GPU 合成器预算 | 🟡 |

## 架构决策

```
Preact + Signals  →  SolidJS         (细粒度响应式，无级联重渲染)
WebGL renderer    →  CanvasRenderer  (无纹理图集，不闪烁)
xterm.reset()     →  serialize addon (重连静默恢复)
clockTick signal  →  纯 CSS 方案      (不进入渲染树)
```

---

## Phase 1: SolidJS 迁移

### 1.1 依赖安装

```bash
cd D:\AI IDE\CC_BOOS
npm install solid-js
npm install --save-dev vite-plugin-solid
```

### 1.2 核心概念映射

| Preact | SolidJS | 说明 |
|--------|---------|------|
| `signal()` | `createSignal()` | 基础响应式原语 |
| `computed()` | `createMemo()` | 派生值 |
| `useEffect()` | `createEffect()` | 副作用 |
| `useState()` | `createSignal()` | 组件状态 |
| `useRef()` | `createSignal()` 或 DOM ref | 引用 |
| `preact/hooks` | `solid-js` | 导入源 |
| `html\`\`` | JSX | 模板语法相同 |
| `.value` | `signal()` 返回 getter+setter | 读取方式不同 |

### 1.3 文件迁移清单

所有文件从 `D:\AI IDE\CC_BOOS\public\js\` 迁移：

| 序号 | 文件 | 变更说明 |
|:--:|------|------|
| 1 | `main.js` | `signal`→`createSignal`, `computed`→`createMemo`, `effect`→`createEffect` |
| 2 | `state.js` | 全部 signal 改为 SolidJS store/atom 模式 |
| 3 | `backend.js` | 无框架依赖，直接保留 |
| 4 | `api.js` | 无框架依赖，保留；signal 写入函数签名更新 |
| 5 | `html.js` | `html\`\`` → SolidJS JSX |
| 6 | `components/App.js` | `preact`→`solid-js`, 用 `createEffect` 替代 `useEffect` |
| 7 | `components/Sidebar.js` | ⚠️ **关键**: 移除 `clockTick.value` 读取，改为 CSS 方案 |
| 8 | `components/TerminalView.js` | 重构为 SolidJS Portal + 细粒度信号 |
| 9 | `components/TerminalInstance.js` | ⚠️ **关键**: CanvasRenderer + serialize addon |
| 10 | `components/XtermTerminal.js` | ⚠️ **关键**: WebGL → CanvasRenderer |
| 11 | `pages/SessionsPage.js` | `useEffect`→`createEffect` |
| 12 | `pages/LaunchPage.js` | 同上 |
| 13 | `pages/ConfigurePage.js` | 同上 |
| 14 | `pages/AboutPage.js` | 同上 |
| 15 | `pages/GoalPage.js` | 同上 |
| 16 | `pages/DecisionPage.js` | 同上 |
| 17 | `pages/DecisionsPage.js` | 同上 |
| 18 | `components/ServerStatus.js` | 保留逻辑，替换 signal |
| 19 | `components/OfflineBanner.js` | 同上 |
| 20 | `components/HealthOverlay.js` | 同上 |
| 21 | `components/ErrorBoundary.js` | SolidJS 有 `ErrorBoundary` 内建 |
| 22 | 其他 components | 按需迁移 |

---

## Phase 2: xterm.js 改造

### 2.1 WebGL → CanvasRenderer

**文件**: `XtermTerminal.js`

```js
// 旧: WebGL renderer (xterm-addon-webgl)
this._webglAddon = new WebglAddon();
this.terminal.loadAddon(this._webglAddon);

// 新: 只使用内置 CanvasRenderer（默认）
// 不加载 WebglAddon，xterm.js 默认使用 CanvasRenderer
// 删除所有 clearTextureAtlas() 调用
// 删除所有 forceRedraw() 调用（CanvasRenderer 不需要）
```

**删除的方法**:
- `forceRedraw()` — 整个方法 + 调用
- `_enableWebglRenderer()` — 整个方法
- `_disposeWebglRenderer()` — 整个方法
- `_clearTextureAtlas()` — 整个方法
- 30s 定时器 `atlasRefreshTimer`

### 2.2 serialize addon — 重连状态保存

**文件**: `TerminalInstance.js`

```bash
npm install xterm-addon-serialize
```

```js
import { SerializeAddon } from 'xterm-addon-serialize';

// 每个 TerminalInstance 持有的 addon
this._serializeAddon = new SerializeAddon();
this.terminal.loadAddon(this._serializeAddon);

// 在 _connect() 中:
// 旧: xterm.reset()  ← 删除！
// 新: 恢复保存的状态
const saved = this._serializeAddon.serialize();
// 如果重连，先 restore:
if (savedState) {
  this.terminal.write(savedState); // 或用 serialize addon 的 deserialize
}
```

**重连流程改造**:
```
旧: WS close → setTimeout → _connect() → xterm.reset() → WS open
新: WS close → serialize terminal state → setTimeout → _connect() → WS open → terminal 状态保持
```

### 2.3 ResizeObserver 稳定性

**文件**: `TerminalInstance.js`, `TerminalResizeDebouncer.js`

```js
// 旧: rAF 每帧 resize（侧边栏 250ms transition 期间 = 15 次 resize）
// 新: 100ms debounce，transition 期间只 resize 2-3 次
const debouncedResize = debounce(() => {
  this._applyResize();
}, 100);

resizeObserver = new ResizeObserver(() => {
  debouncedResize();
});
```

**额外优化**: 侧边栏拖动时暂停 xterm.resize()

```js
// 在 body.is-resizing-sidebar 期间，完全跳过 xterm.resize()
// 拖动结束后只调用一次 _applyResize()
```

---

## Phase 3: 信号架构重新设计

### 3.1 移除 clockTick 从渲染树

**当前丑代码** (Sidebar.js):
```js
// ❌ 每个 SessionRow 都读 clockTick → 每 5s 全树重渲染
const tick = clockTick.value;
const relativeTime = formatRelative(timestamp, tick);
```

**新方案**: 纯 CSS/Web Component

```js
// ✅ 使用 <relative-time> 自定义元素，自管理更新
// 或者 CSS animation 在时钟图标上渐进变色
// SessionRow 不读任何 time signal
```

**实现选择**:
1. **推荐**: `<time-ago>` 自定义元素 — 每个元素自己的 30s setInterval，独立更新 textContent，不触发框架重渲染
2. 备选: 移除实时相对时间，只显示静态格式化时间

### 3.2 State 原子化

**文件**: `state.js`

```js
// 旧: 全局 signals 大杂烩
export const sessions = signal([]);
export const clockTick = signal(Date.now());

// 新: SolidJS stores + 细粒度 atoms
export const [sessions, setSessions] = createSignal([]);
export const [folders, setFolders] = createSignal([]);
// clockTick 彻底删除！时间显示用 <time-ago> 组件
```

### 3.3 Agent 状态批处理

**文件**: `TerminalView.js`, `App.js`

```js
// 旧: 两个路径写同一个 signal，一个直接写一个批处理
// App.js SSE 路径: 50ms debounce + rAF batch
// TerminalView.js WS 路径: 直接写 signal.value = ...  ← 跳过批处理！

// 新: 统一路径
// 1. 创建共享事件总线
const agentStatusBus = createEventBus();

// 2. TerminalView WS 路径 → 投递到 bus
agentStatusBus.emit({ type: 'agent_status', ... });

// 3. App.js 统一监听 bus → 50ms batch → 写入 signal
// 所有 agent_status 更新走同一条批处理管道
```

---

## Phase 4: CSS 清理

### 4.1 删除/合并不必要的无限动画

保留以下（用户可见状态需要）:
- `server-pulse` — 服务器状态呼吸
- `reconnect-spin` — 重连旋转指示器
- `indeterm` — 进度条不确定状态

删除/用 CSS transition 替代:
- `agent-pulse` → 用 `transition: opacity 0.2s` 一次性过渡
- `dirty-pulse` → 同上
- `save-pulse` → 同上
- `tree-dot-breathe-idle` / `tree-dot-breathe-working` → CSS transition
- `tunnel-live-pulse` → CSS transition
- `restart-spin` → 保留但降低 z-index 确保不影响其他层
- `health-spin` → 保留但只在 HealthOverlay 可见时激活

### 4.2 侧边栏 resize 优化

```css
/* sidebar.css */
.sidebar {
  /* 删除 transition: width .25s — 改为 JS 控制 */
  /* 或保留 transition 但终端在 transition 期间跳过 resize */
}

/* terminals.css */
.session-pane {
  /* 加强 contain 以隔离 layout 影响 */
  contain: strict;
}
```

---

## Phase 5: 验证清单

迁移完成后逐项验证:

- [ ] 启动 BOOS，终端无花屏
- [ ] 切换 Session Tab，终端内容无闪烁
- [ ] 侧边栏展开/折叠，终端无撕裂
- [ ] 侧边栏拖动 resize，终端无抖动
- [ ] Agent 状态更新，无视觉跳动
- [ ] 关闭 → 重新打开 BOOS，终端内容保留
- [ ] WS 断开 → 重连（断网 5s → 恢复），终端不清屏
- [ ] 10 分钟运行，页面上无异常 refresh
- [ ] DevTools Performance 面板: 60fps 稳定，无 dropped frames
- [ ] 内存: 10 分钟不持续增长（无泄漏）

---

## 风险点

| 风险 | 缓解 |
|------|------|
| SolidJS 与 xterm.js DOM 操作冲突 | Terminal 用 SolidJS `ref` + 直接 DOM 操作，不经过 JSX |
| serialize addon 大终端性能 | 只在重连前序列化，正常运行时不上报 |
| CanvasRenderer 性能低于 WebGL | PTY 终端行列数有限（200x50），Canvas 完全够 |
| 迁移后测试覆盖不足 | 可靠性工程师-A2 在迁移完成后做回归 |

---

## 文件总览

```
新增依赖:
  solid-js, xterm-addon-serialize

删除依赖:
  preact, @preact/signals, xterm-addon-webgl

修改文件 (~22 files):
  index.html, sw.js
  js/main.js, js/state.js, js/api.js, js/html.js
  js/components/App.js, Sidebar.js, TerminalView.js, TerminalInstance.js,
    XtermTerminal.js, ServerStatus.js, OfflineBanner.js, HealthOverlay.js,
    ErrorBoundary.js, Toast.js, DialogHost.js
  js/pages/SessionsPage.js, LaunchPage.js, ConfigurePage.js, AboutPage.js,
    GoalPage.js, DecisionPage.js, DecisionsPage.js
  css/terminals.css, sidebar.css, feedback.css, workspace.css, widgets.css

不变文件 (~10 files):
  js/backend.js, js/util.js, js/icons.js, js/dialog.js, js/toast.js,
  js/streaming.js, js/components/Card.js, Modal.js, Popover.js, Picker.js,
    DirectoryPicker.js, ProgressList.js, SearchBar.js, useDragSort.js,
    TerminalKeyBar.js, TerminalResizeDebouncer.js (简化), etc.
```
