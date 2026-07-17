# BOOS 前端架构文档

> 作者: 前端工程师 · 2026/07/14
> 版本: v1.0 (基于当前 main 分支)

---

## 目录

1. [架构概览](#1-架构概览)
2. [技术栈详解](#2-技术栈详解)
3. [文件结构](#3-文件结构)
4. [数据流与状态管理](#4-数据流与状态管理)
5. [页面结构](#5-页面结构)
6. [组件体系](#6-组件体系)
7. [终端子系统](#7-终端子系统)
8. [CSS 设计体系](#8-css-设计体系)
9. [关键交互流程](#9-关键交互流程)
10. [已知问题与待修复项](#10-已知问题与待修复项)
11. [开发指南](#11-开发指南)

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    browser (PWA / --app=)                │
│                                                         │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │  Sidebar    │  │   Pages      │  │   Overlays      │  │
│  │  (导航树)   │  │  (7个页面)   │  │  (5个覆盖层)    │  │
│  └─────┬──────┘  └──────┬───────┘  └────────┬────────┘  │
│        │                │                   │            │
│  ┌─────┴────────────────┴───────────────────┴──────────┐ │
│  │              Preact (Signals + htm)                  │ │
│  └────────────────────────┬────────────────────────────┘ │
│                           │                              │
│  ┌────────────────────────┼──────────────────────────┐   │
│  │  state.js (全局信号)    │  api.js (fetch 封装)     │   │
│  │  i18n.js (汉化)         │  backend.js (URL 路由)   │   │
│  └────────────────────────┼──────────────────────────┘   │
│                           │                              │
└───────────────────────────┼──────────────────────────────┘
                            │ fetch() / WebSocket
                            ▼
                   ┌────────────────────┐
                   │  BOOS 后端          │
                   │  Express + node-pty │
                   │  localhost:7777     │
                   └────────────────────┘
```

### 核心设计原则

| 原则 | 实现 |
|------|------|
| **无状态后端** | 所有 UI 状态在 `state.js` signals 中，后端只提供数据 |
| **细粒度响应式** | Preact Signals — 组件直接读取 `.value`，无需 Context |
| **单入口** | `main.js` → `render(App, #app)` — 所有生命周期在此编排 |
| **版本路由** | GH Pages 按 `<version>/` 子目录部署，前端 meta 自检版本 |
| **跨域透明** | `backend.js` 统一处理 localhost / hosted / tunnel 三种 origin |

---

## 2. 技术栈详解

### 2.1 UI 框架: Preact + Signals + htm

- **Preact**: 3KB React 替代，兼容 JSX 语义
- **@preact/signals**: 细粒度响应式，`signal()` + `computed()`
- **htm**: JSX-free 模板语法，``html`<div class=${cls}>${children}</div>` ``

```js
// 示例：Signals 驱动的细粒度更新
import { signal, computed } from '@preact/signals';

export const sessions = signal([]);
export const activeSessionId = signal(null);

// 组件直接读取 .value，Preact 自动订阅
export function SessionsPage() {
  const list = sessions.value;      // 自动订阅 sessions 变化
  const id = activeSessionId.value;  // 自动订阅 activeSessionId 变化
  // ...
}
```

**为什么不用 React / Vue / Svelte**: BOOS 需要极致轻量的 bundle，Preact 的 3KB gzip + Signals 的细粒度更新最符合"桌面级 Web App"的性能要求。htm 消除了 JSX 编译步骤，开发时直接 import。

### 2.2 终端: xterm.js 生态

```
TerminalView (Preact 壳)
  └─ TerminalInstance (WS 传输 + 生命周期)
       └─ XtermTerminal (xterm.js 绑定 + 渲染器)
            ├─ @xterm/xterm         — 核心终端
            ├─ @xterm/addon-fit     — 自适应尺寸
            ├─ @xterm/addon-webgl   — GPU 加速渲染 (桌面)
            ├─ @xterm/addon-web-links — 可点击链接
            └─ @xterm/addon-clipboard — 剪贴板支持
```

**关键设计决策**:
- 桌面使用 WebGL 渲染器 (性能)，移动端降级 DOM 渲染器 (兼容性)
- `TerminalResizeDebouncer` 防抖 resize，避免频繁 PTY resize 导致事件风暴
- 重连时保留 scrollback 位置，不被 reset 到顶部
- IME (中文输入) 通过 `compositionstart/end` 事件控制光标可见性

### 2.3 CSS: Design Tokens 体系

17 个 CSS 文件，通过 CSS Custom Properties 实现主题切换。详见 [§8 CSS 设计体系](#8-css-设计体系)。

---

## 3. 文件结构

### 3.1 入口层 (`public/js/`)

| 文件 | 行数 | 职责 | 依赖 |
|------|------|------|------|
| `main.js` | 304 | 启动入口：loadPersisted → bootVersionGuard → refreshAll → 定时器 | state, api, App |
| `state.js` | 440 | 全局 Signals 状态 + 持久化 + 主题/侧边栏控制 | i18n |
| `api.js` | 471 | fetch 封装 + 所有 API loader + resume 去重 | state, backend |
| `html.js` | ~30 | Preact htm 绑定 | preact, htm |
| `i18n.js` | 705 | 集中式汉化字典 `T.*` | 无 |
| `backend.js` | 161 | URL 路由 (httpBase/wsBase) + token/deviceId 管理 | 无 |
| `streaming.js` | ~200 | NDJSON 流读取 (launch 进度) | api |
| `toast.js` | ~60 | Toast 通知 | state |
| `dialog.js` | ~150 | `boosConfirm` / `boosPrompt` 模态对话框 | — |
| `util.js` | ~80 | `fmtAgo()` 时间格式化等工具函数 | i18n |
| `keybindings.js` | ~200 | 全局键盘快捷键注册 | state |
| `launchState.js` | ~150 | Launch 页面状态管理 (CLI/目录/仓库选择) | state, config |
| `icons.js` | ~500 | 内联 SVG 图标组件库 | preact |

### 3.2 组件层 (`public/js/components/`) — 32 个组件

**核心容器**:

| 组件 | 行数 | 职责 |
|------|------|------|
| `App.js` | 77 | 根组件，tab 路由，overlay 编排 |
| `Sidebar.js` | 572 | 侧边栏 + SessionTree + FolderGroup + 拖拽排序 |
| `PageTitleBar.js` | ~80 | 页面标题栏 (标题 + 状态 + 操作) |

**终端相关**:

| 组件 | 行数 | 职责 |
|------|------|------|
| `TerminalView.js` | 97 | Preact 壳 — 管理 TerminalInstance 生命周期 |
| `TerminalInstance.js` | 512 | WS 传输 + xterm 绑定 + resize/paste/IME |
| `XtermTerminal.js` | 404 | xterm.js 底层封装 (渲染器/主题/滚动) |
| `WorkspaceTerminal.js` | 77 | 工作区终端区域 (选中 agent → TerminalView) |
| `TerminalKeyBar.js` | ~120 | 移动端虚拟键盘栏 |
| `TerminalResizeDebouncer.js` | ~100 | Resize 防抖策略 |

**画布相关 (前端工程师负责)**:

| 组件 | 行数 | 职责 |
|------|------|------|
| `AgentCanvas.js` | 135 | 自由画布 — 节点拖拽/缩放/平移 |
| `AgentNode.js` | 40 | 单个 Agent 节点 — 名称+图标+状态点 |

**通用 UI**:

| 组件 | 职责 |
|------|------|
| `Card.js` | 可折叠卡片容器 |
| `Modal.js` | 通用模态对话框 |
| `Popover.js` | 弹出层 (锚点定位) |
| `Picker.js` | 通用选择器 |
| `EntityFormModal.js` | 实体表单弹窗 (CLI/仓库/文件夹) |
| `DirectoryPicker.js` | 目录浏览器 |
| `ProgressList.js` | 进度列表 (克隆进度等) |
| `SearchBar.js` | 搜索栏 + 过滤器 |
| `useDragSort.js` | 拖拽排序 hook |

**覆盖层 (Overlay)**:

| 组件 | 职责 |
|------|------|
| `HealthOverlay.js` | 后端离线覆盖层 |
| `RestartOverlay.js` | 后端重启中覆盖层 |
| `PendingApprovalOverlay.js` | 远程设备待批准覆盖层 |
| `OfflineBanner.js` | 离线横幅 |
| `Toast.js` | Toast 通知容器 |
| `DialogHost.js` | 模态对话框宿主 |
| `LoadSessionModal.js` | 加载已有会话弹窗 |

### 3.3 页面层 (`public/js/pages/`) — 7 个页面

| 页面 | 行数 | 路由 | 职责 |
|------|------|------|------|
| `SessionsPage.js` | 419 | `#sessions` | 终端视图 + Tab 管理 + 恢复控制 |
| `WorkspacePage.js` | 224 | `#workspace` | 画布 + 终端分屏 |
| `LaunchPage.js` | ~500 | `#launch` | 新建会话 (CLI/目录/仓库) |
| `ConfigurePage.js` | ~800 | `#configure` | 设置 (外观/CLI/仓库/快捷键) |
| `RemotePage.js` | ~600 | `#remote` | 远程访问 (隧道/令牌/设备) |
| `AboutPage.js` | ~200 | `#about` | 关于 (版本/安装/升级) |
| `DecisionsPage.js` | ~300 | `#decisions` | 决策审批面板 |

### 3.4 CSS 层 (`public/css/`) — 17 个文件

| 文件 | 职责 |
|------|------|
| `tokens.css` | **Design Tokens** — 所有 CSS 变量定义 |
| `base.css` | 全局重置 + body/html 基础样式 |
| `layout.css` | `.app` 布局 (sidebar + main) |
| `sidebar.css` | 侧边栏 + 导航 + SessionTree |
| `cards.css` | `.card` 卡片组件 |
| `forms.css` | 表单控件 (input/select/button) |
| `widgets.css` | 通用小组件 (badge/tag/pill) |
| `feedback.css` | Toast/通知 |
| `modal.css` | 模态框 |
| `terminals.css` | 终端容器 + xterm 样式 |
| `workspace.css` | **画布 + AgentNode + 分屏** |
| `wco.css` | Window Controls Overlay (PWA) |
| `responsive.css` | 响应式断点 |
| `dark.css` | `[data-theme="dark"]` 覆盖 |
| `tables.css` | 表格样式 |
| `loadsession.css` | 加载会话弹窗 |

---

## 4. 数据流与状态管理

### 4.1 Signals 总览

```
state.js
├── 服务端数据 (server-driven)
│   ├── config        signal(null)          // 全局配置
│   ├── capabilities  signal({webTerminal}) // 后端能力
│   ├── sessions      signal([])            // 持久化会话列表
│   ├── deletedSessions signal([])          // 已删除会话
│   ├── folders       signal([])            // 文件夹列表
│   ├── workspaces    signal([])            // 工作空间
│   └── serverHealth  signal({state})       // 健康状态
│
├── UI 状态 (持久化 localStorage)
│   ├── activeTab              signal('sessions')
│   ├── activeSessionId        signal(null)
│   ├── openSessionTabIds      signal([])
│   ├── sidebarCollapsed       signal(false)
│   ├── sidebarWidth           signal(232)
│   ├── accentColor            signal('#2f6fa3')
│   ├── themeMode              signal('system')
│   └── foldersCollapsed       signal({})
│
├── 工作区状态
│   ├── workspaceAgentActivity  signal({})    // agent 活动状态
│   ├── workspaceFolderId       signal(null)  // 当前画布文件夹
│   └── workspaceSplitRatio     signal(0.5)
│
└── 派生 (computed)
    └── sessionsByFolder  computed(() => ...)  // 按文件夹分组
```

### 4.2 数据加载流程

```
main.js boot
  │
  ├─ loadPersisted()              // 从 localStorage 恢复 UI 状态
  │   ├─ sidebarCollapsed, sidebarWidth
  │   ├─ accentColor, themeMode
  │   ├─ folders (缓存)
  │   ├─ sessions (缓存)
  │   └─ activeSessionId
  │
  ├─ bootVersionGuard()           // 版本守卫 — 不匹配则跳转
  │
  ├─ [远程] /api/devices/me      // 设备注册
  │
  ├─ loadConfig()                 // GET /api/config + /api/capabilities
  ├─ refreshAll()                 // GET /api/sessions + /api/folders + /api/workspaces
  ├─ pollHealth()                 // GET /api/health
  │
  └─ setInterval(5s)              // 定时刷新
      ├─ loadSessions()
      ├─ loadDeletedSessions()
      ├─ loadFolders()
      ├─ loadWorkspaces()
      ├─ pollHealth()
      └─ clockTick.value = now    // 驱动 fmtAgo 刷新
```

### 4.3 Resume 去重机制

```js
// api.js 中的 resumeInFlight Map
const resumeInFlight = new Map(); // sessionId → Promise

export function resumeSession(sessionId) {
  const cached = resumeInFlight.get(sessionId);
  if (cached) return cached;   // ← 第二次调用直接返回同一个 Promise

  const p = (async () => { /* POST /resume */ })();
  resumeInFlight.set(sessionId, p);
  p.then(
    () => resumeInFlight.delete(sessionId),
    (e) => { resumeInFlight.delete(sessionId); resumeFailed.set(sessionId, e); }
  );
  return p;
}
```

**触发场景**: Sidebar 点击已退出 session → SessionsPage auto-resume effect 同时触发 → 两次调用合并为一次请求。

### 4.4 失败粘滞缓存

```js
const resumeFailed = new Map(); // sessionId → Error

// resumeSession 先检查: 如果已失败，直接 reject，不再发请求
// 直到 clearResumeFailure(id) 被调用 (用户手动点 Retry 或 switchCli)
```

**目的**: 防止 SessionsPage 的 auto-resume effect 在 CLI 持续崩溃时死循环。

---

## 5. 页面结构

### 5.1 SessionsPage (核心页面)

```
┌─ PageTitleBar ──────────────────────────────────────────┐
│  session title              server status    [Refresh]   │
├─ SessionTabs ───────────────────────────────────────────┤
│  [tab1] [tab2] [tab3●] ...              [▶][■] [...]   │
│                                     SessionControls     │
│                                     SessionMenu         │
├─ session-pane ──────────────────────────────────────────┤
│  ┌─ terminal-stack ──────────────────────────────────┐  │
│  │  terminal-layer (is-active)  ← 当前可见           │  │
│  │    └─ TerminalView → TerminalInstance → xterm     │  │
│  │  terminal-layer              ← 其他 (隐藏)        │  │
│  │    └─ TerminalView → TerminalInstance → xterm     │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  OR (not running):                                      │
│  ┌─ terminal-empty ──────────────────────────────────┐  │
│  │  恢复失败: <error>          [重试]                 │  │
│  │  OR: 会话已停止              [恢复]                │  │
│  │  OR: 正在恢复会话…                                 │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Session Tabs**: 可拖拽排序 (`useDragSort`)，支持关闭。每个 tab 维护一个 TerminalInstance。

### 5.2 WorkspacePage (画布 + 终端)

```
┌─ PageTitleBar ──────────────────────────────────────────┐
│  工作区名 · N 个 agent                    server status  │
├─ workspace-page (flex column) ──────────────────────────┤
│  ┌─ workspace-canvas-pane ──── flex: splitPct ────────┐ │
│  │  AgentCanvas                                        │ │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐            │ │
│  │  │AgentNode │  │AgentNode │  │AgentNode │            │ │
│  │  │(working) │  │(idle)    │  │(exited)  │            │ │
│  │  └─────────┘  └─────────┘  └─────────┘            │ │
│  │  ┌─────────┐                                        │ │
│  │  │AgentNode │    ← 可拖拽, Ctrl+Wheel 缩放        │ │
│  │  └─────────┘                                        │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─ workspace-split-handle (6px, row-resize) ─────────┐ │
│  │  ═══  grip  ═══                                    │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─ workspace-terminal-pane ── flex: 100-splitPct ────┐ │
│  │  WorkspaceTerminal                                  │ │
│  │    └─ TerminalView (选中 agent 的终端)             │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Agent 分组逻辑**:
1. 若 `workspaceFolderId` 设置 → 显示该文件夹内所有 session
2. 否则 → `_findSiblingGroup()` 自动检测共享父目录的 session 群 (≥2 siblings)
3. 若无 sibling group → 使用当前活跃 session 的 workspace/cwd basename

### 5.3 LaunchPage

三种启动模式:
- **自动工作空间**: 创建 `ws-N` + 克隆配置的仓库
- **已有文件夹**: 直接使用用户选择的目录
- **加载已有会话**: 扫描本地 `~/.claude` / `CODEX_HOME` / `~/.copilot`

启动流程通过 NDJSON 流 (`streaming.js`) 实时显示克隆进度。

---

## 6. 组件体系

### 6.1 组件分类

```
组件体系
├── 容器组件 (Container)
│   ├── App — 根路由
│   ├── Sidebar — 导航 + 树
│   └── SessionsPage / WorkspacePage — 页面容器
│
├── 展示组件 (Presentational)
│   ├── AgentNode — 画布节点
│   ├── ServerStatus — 状态药丸
│   ├── PageTitleBar — 标题栏
│   └── Card / Modal / Popover — 通用 UI
│
├── 功能组件 (Functional)
│   ├── TerminalView — xterm 管理
│   ├── TerminalInstance — WS + 生命周期
│   └── AgentCanvas — 画布交互
│
├── Hook
│   └── useDragSort — 拖拽排序
│
└── 覆盖层 (Overlay)
    ├── HealthOverlay — 离线
    ├── RestartOverlay — 重启
    ├── PendingApprovalOverlay — 设备审批
    └── OfflineBanner — 离线横幅
```

### 6.2 Sidebar 树形结构

```
Sidebar
├── sidebar-brand (BOOS. logo)
├── sidebar-nav
│   ├── NavItem(launch)
│   ├── NavItem(workspace)
│   ├── NavItem(decisions)
│   ├── NavItem(remote) [仅本地]
│   └── NavItem(configure)
├── SessionTree [!collapsed]
│   ├── SearchBar
│   ├── tree-head (标签 + 新建文件夹按钮)
│   ├── FolderGroup × N
│   │   ├── tree-folder-head (折叠/展开 + 操作)
│   │   │   ├── 新建会话 (IconPlus)
│   │   │   ├── 画布打开 (IconCanvas)
│   │   │   ├── 重命名 (IconPencil) [非 unsorted]
│   │   │   └── 删除 (IconClose) [非 unsorted]
│   │   └── tree-folder-body
│   │       └── SessionRow × N
│   │           ├── tree-dot (状态点)
│   │           ├── tree-label (标题)
│   │           ├── tree-session-actions (rename/delete)
│   │           └── tree-meta (fmtAgo)
│   ├── DeletedSessionsGroup
│   │   └── DeletedSessionRow × N
│   └── ImportById (粘贴 UUID 导入)
└── sidebar-foot
    ├── collapse-toggle
    └── install-button [PWA 未安装时]
```

**拖拽交互**:
- SessionRow → FolderGroup: 移动到文件夹
- SessionRow → SessionRow (同文件夹): 排序
- FolderGroup → FolderGroup: 文件夹排序
- 使用 `useDragSort` hook 实现

---

## 7. 终端子系统

### 7.1 三层架构

```
┌─ TerminalView (Preact 壳) ──────────────────────────────┐
│  职责: 管理 TerminalInstance 生命周期, 主题切换          │
│  状态: hostRef, instanceRef, displaced, reattachNonce    │
│  接口: sendInput(data)                                   │
│                                                         │
│  关键行为:                                               │
│  - terminalId 变化 → dispose 旧实例, 创建新实例          │
│  - visible 变化 → setVisible / focus / blur              │
│  - displaced → 显示 "其他设备已接管" 覆盖层              │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─ TerminalInstance (WS 传输) ──────────────────────┐  │
│  │  职责: WebSocket 连接, 数据转发, resize 传播       │  │
│  │  状态: ws, xterm, host, inReplay, isVisible        │  │
│  │                                                   │  │
│  │  关键行为:                                         │  │
│  │  - _connect() → new WebSocket(wsUrl)               │  │
│  │  - onmessage: output → xterm.write()               │  │
│  │                exit → 显示退出信息                  │  │
│  │                agent_status → 更新 activity signal  │  │
│  │  - 重连: 指数退避 (500ms → 8s max)                 │  │
│  │  - resize 传播: cols/rows → WS frame               │  │
│  │  - paste 处理: Ctrl+V / Shift+Insert               │  │
│  │  - IME: compositionstart/end → 光标可见性          │  │
│  │  - OSC 10/11: 颜色查询响应 (Codex 需要)            │  │
│  ├───────────────────────────────────────────────────┤  │
│  │                                                   │  │
│  │  ┌─ XtermTerminal (xterm.js 封装) ─────────────┐ │  │
│  │  │  职责: 终端实例, 渲染器, 主题, 尺寸          │ │  │
│  │  │  状态: raw (Terminal), fitAddon, webglAddon   │ │  │
│  │  │                                              │ │  │
│  │  │  关键行为:                                    │ │  │
│  │  │  - open(host) → 挂载到 DOM                    │ │  │
│  │  │  - _enableWebglRenderer() → GPU 加速          │ │  │
│  │  │  - layout(w,h) → 计算 cols/rows → raw.resize  │ │  │
│  │  │  - applyResolvedTheme() → 暗/亮切换           │ │  │
│  │  │  - forceRedraw() → clearTextureAtlas + refresh│ │  │
│  │  │  - dispose() → 完整清理                       │ │  │
│  │  └──────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 7.2 数据流

```
用户按键
  → xterm.js onKeyDown
  → xterm.onData(data)
  → TerminalInstance._sendInput(data)
  → WS frame { type: 'input', data }
  → 后端 node-pty.write(data)
  → CLI 输出
  → node-pty.onData
  → WS frame { type: 'output', data }
  → TerminalInstance.ws.onmessage
  → xterm.write(data)
  → 渲染到 canvas/DOM
```

### 7.3 Resize 流程

```
容器尺寸变化 (ResizeObserver)
  → TerminalInstance.layout(w, h)
  → TerminalResizeDebouncer.resize(cols, rows)
  → [debounce] XtermTerminal.resize(cols, rows)
  → raw.resize(cols, rows)
  → xterm.onResize({cols, rows})
  → TerminalInstance._sendResize(cols, rows)
  → WS frame { type: 'resize', cols, rows }
  → 后端 pty.resize(cols, rows)
```

**防抖策略**: `TerminalResizeDebouncer` 使用分级延迟:
- 首次: 立即
- 连续: 16ms (一帧)
- 结束: 60ms + 200ms 重试

### 7.4 Terminal Tab 切换 (当前实现)

```
SessionsPage: terminalSessions.map(s => (
  <div class="terminal-layer" data-active={s.id === session.id}>
    <TerminalView key={s.id} terminalId={s.id} visible={active} />
  </div>
))
```

**所有 running session 都有 TerminalInstance 实例存活**。切换时:
- `visible=false` 的 terminal: `blur()` + CSS 隐藏
- `visible=true` 的 terminal: `focus()` + `scheduleLayout({forceRedraw})`

**⚠️ 问题**: 非 active 的 terminal 仍在后台持有 WebSocket 连接和 xterm 实例，内存占用随 tab 数量线性增长。

---

## 8. CSS 设计体系

### 8.1 Design Tokens (`tokens.css`)

```css
:root {
  /* 表面色 */
  --bg:            #f6f8fa;     /* 页面背景 */
  --bg-elev:       #ffffff;     /* 卡片表面 */
  --sidebar-bg:    #f6f8fa;     /* 侧边栏 */

  /* 中性色 (不受 accent 影响) */
  --ui-border:     #d8d4c6;
  --ui-border-soft: #e6e2d4;

  /* 边框 (随 accent 色调变化) */
  --border:        #d3e1ed;
  --border-soft:   #d8e4ee;
  --border-strong: #c0d5e5;

  /* 墨色 (文本) */
  --ink:        #1a1815;        /* 主文本 */
  --ink-mid:    #534e44;        /* 次要 */
  --ink-muted:  #8a8475;        /* 提示 */
  --ink-faint:  #b5af9d;        /* 最弱 */

  /* 品牌色 (Ocean blue 默认, 可自定义) */
  --accent:        #2f6fa3;
  --accent-deep:   #25577f;
  --accent-soft:   rgba(47, 111, 163, 0.10);
  --accent-softer: rgba(47, 111, 163, 0.04);

  /* 状态色 */
  --green:  #4a8a4a;
  --yellow: #c4892b;
  --red:    #b73f3f;
  --blue:   #4a73a5;

  /* 字体 */
  --body:    "Geist", ...;
  --mono:    "JetBrains Mono", ...;

  /* 间距 */
  --s-1: 4px; --s-2: 8px; ... --s-16: 64px;

  /* 圆角 */
  --r-sm: 3px; --r: 4px; --r-md: 5px; --r-lg: 6px;

  /* 阴影 */
  --shadow-sm / --shadow / --shadow-md / --shadow-lg

  /* 侧边栏宽度 */
  --sidebar-w: 232px;
  --sidebar-w-collapsed: 44px;
}
```

### 8.2 主题切换机制

```
state.js: applyTheme()
  │
  ├─ resolveDark(mode)
  │   ├─ 'dark' → true
  │   ├─ 'light' → false
  │   └─ 'system' → matchMedia('(prefers-color-scheme: dark)')
  │
  ├─ document.documentElement.dataset.theme = 'dark' | 'light'
  │   → CSS: [data-theme="dark"] { ... } 覆盖
  │
  └─ applyAccentCssVars()
      → 根据 accent + dark/light 计算所有 CSS 变量
      → document.documentElement.style.setProperty(...)
```

**暗色主题**: `dark.css` 提供 `[data-theme="dark"]` 覆盖，调整表面色和边框色。

**accent 衍生**: `state.js` 中 `applyAccentCssVars()` 根据用户选择的 accent 颜色，通过线性插值 (`lerp`) 计算出完整的表面色、边框色、hover 色等。

### 8.3 文件依赖关系

```
tokens.css (基础变量)
  │
  ├── base.css (全局重置 + body)
  │
  ├── layout.css (.app 布局)
  │     └── sidebar.css (侧边栏)
  │
  ├── cards.css / forms.css / widgets.css / feedback.css / modal.css
  │     (通用组件, 依赖 tokens)
  │
  ├── terminals.css (终端样式)
  │
  ├── workspace.css (画布 + AgentNode)
  │
  ├── responsive.css (断点覆盖)
  │
  ├── wco.css (PWA 窗口控制)
  │
  ├── dark.css ([data-theme="dark"] 覆盖)
  │
  └── tables.css / loadsession.css (特定页面)
```

---

## 9. 关键交互流程

### 9.1 启动新会话

```
用户点击 Launch → LaunchPage 渲染
  │
  ├─ 选择 CLI (claude/codex/copilot/自定义)
  ├─ 选择工作目录 (自动/已有)
  ├─ [可选] 选择仓库
  │
  └─ 点击 "启动"
      │
      ├─ buildLaunchBodyFromState() 构建请求体
      ├─ streamNewSession(body) → POST /api/sessions/new
      │   └─ NDJSON 流读取:
      │       ├─ {type:'workspace'} → 显示工作空间信息
      │       ├─ {type:'clone-progress', percent} → 更新进度条
      │       └─ {type:'launched', session} → 完成
      │
      └─ selectSession(launched.id) → 切换到 SessionsPage
```

### 9.2 Resume 会话

```
Sidebar 点击已退出 session
  │
  ├─ selectSession(id) → activeSessionId.value = id
  ├─ SessionsPage mount
  │   ├─ useEffect: session.status !== 'running'
  │   ├─ resumeSession(id)
  │   │   ├─ resumeFailed 检查 → 如有缓存错误直接 reject
  │   │   ├─ resumeInFlight 检查 → 如有进行中 Promise 直接返回
  │   │   └─ POST /api/sessions/:id/resume
  │   │       ├─ 后端: 查找 session → spawn CLI → 返回 {launched}
  │   │       └─ 前端: loadSessions() → 更新 sessions signal
  │   │
  │   └─ session.status === 'running' → 渲染 TerminalView
  │       └─ TerminalInstance → WebSocket 连接 → 显示终端
```

### 9.3 画布 Agent 选择

```
用户双击 AgentNode
  │
  ├─ AgentCanvas.onDblClick(agentId)
  ├─ selectWorkspaceAgent(id)
  │   ├─ ensureOpenSessionTab(id)
  │   ├─ activeSessionId.value = id
  │   └─ 不切换到 sessions tab — 保持 workspace 视图
  │
  └─ WorkspaceTerminal 重新渲染
      ├─ agent 变化 → TerminalView key 变化 → 新 TerminalInstance
      └─ 如果 session 未运行 → auto-resume effect 触发
```

### 9.4 终端 displaced (抢占)

```
Session A 在浏览器 X 中活跃
  │
  ├─ 浏览器 Y 打开同一 session
  ├─ 后端检测到: WS code=4001 → 发给浏览器 X
  ├─ X 的 TerminalInstance._handleClose(ev.code === 4001)
  │   └─ onDisplaced() → setDisplaced(true)
  │
  └─ TerminalView 渲染 displaced 覆盖层
      └─ "其他设备已接管此会话" + "接管回来" 按钮
          └─ 点击 → setDisplaced(false) + setReattach(+1)
              └─ TerminalView useEffect → dispose 旧实例 + 新建
```

---

## 10. 已知问题与待修复项

### 🔴 P0: WorkspacePage 空状态

**位置**: `WorkspacePage.js` L59-99

**根因**: 当 `activeSessionId` 为 null 且无 sibling group 时:
- `_findSiblingGroup()` → null
- `group` = null → `activeKey` = `_sessionKey(activeSession, null)` = `''` (falsy)
- filter 条件 `if (!activeKey) return false` → 所有 session 被过滤
- 页面显示 "0 个 agent" 空状态

**修复方案**:
1. 无 group 且无 activeKey 时 fallback 到显示所有 session
2. 或添加明确的空状态引导 (如 "请先选择会话或创建文件夹")

### 🟡 P0: AgentNode 拖拽边界 + 选中态动画

**位置**: `AgentCanvas.js` L77-89, `workspace.css` L72-88

**现状**:
- 拖拽边界用 `MIN_VISIBLE_PX=40` 计算，但没有 grid snap
- 选中态只有 CSS `border-color` + `box-shadow` 变化，缺少过渡动画
- `AgentNode` 的 `transition: border-color 0.15s, box-shadow 0.15s` 不够平滑

**修复方案**:
1. 添加 `transform: scale(1.05)` + `transition: all 0.2s ease` 选中动画
2. 拖拽释放时 snap 到最近 grid 点 (可选)
3. 边界反弹动画 (拖出边界 → 弹回)

### 🟡 P0: 终端 Tab 切换闪烁

**位置**: `TerminalView.js` L31-49, `SessionsPage.js` L380-400

**现状**: 虽然所有 running session 都有 TerminalInstance 存活，但 `visible` 切换时:
- `setVisible(true)` → `scheduleLayout({immediate:true, retries:true, forceRedraw:true})`
- `forceRedraw()` = `clearTextureAtlas()` + `refresh()` → 一帧空白

**修复方案**:
1. 减少 `forceRedraw` 调用 — 仅在尺寸确实变化时
2. 使用 CSS `visibility: hidden` 替代 `display: none` 避免重排
3. WebGL 上下文切换优化 (避免 texture atlas 完全清除)

### 🟢 P1: MCP 连接

**现状**: `settings.local.json` 中 5 个 MCP server 配置了但未全部连接:
- ✅ agent-bus (SSE, port 7777) — 已连接
- ❌ filesystem / playwright / fetch / sequential-thinking — MCP 工具不可用

**可能原因**: MCP server 进程未启动 / 路径不存在 / node 模块缺失

### 🟢 P2: 暗色主题覆盖不完整

**现状**: `dark.css` 覆盖了主要变量，但部分组件 (AgentNode, TerminalKeyBar) 的硬编码颜色未适配。

### 🟢 P3: 国际化

**现状**: `i18n.js` 已有完整中文字典，但仍有部分硬编码中文字符串散落在组件中。

---

## 11. 开发指南

### 11.1 本地开发

```bash
# 启动后端
cd /d/AI IDE/CC_BOOS
node server.js

# 浏览器访问 http://localhost:7777
# 开发模式: 热重载 SSE (/api/dev/reload)
```

### 11.2 添加新组件

```js
// public/js/components/MyComponent.js
import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { T } from '../i18n.js';

export function MyComponent({ prop1, prop2 }) {
  const [state, setState] = useState(null);

  return html`
    <div class="my-component">
      <span>${T.some.key}</span>
      <button class="action primary" onClick=${() => setState('clicked')}>
        ${state || 'Click me'}
      </button>
    </div>
  `;
}
```

### 11.3 添加新信号

```js
// state.js
export const myNewSignal = signal(initialValue);

// 任何组件中
import { myNewSignal } from '../state.js';
const value = myNewSignal.value;  // 自动订阅
```

### 11.4 CSS 命名约定

- **BEM-lite**: `.component`, `.component__element`, `.component--modifier`
- **状态**: `.is-active`, `.is-running`, `.is-selected`
- **工具类**: `.text-muted`, `.flex-center`
- **响应式**: `@media (max-width: 640px) { ... }` 在 `responsive.css`

### 11.5 关键文件修改检查清单

| 修改 | 需同步更新 |
|------|-----------|
| 新增 signal | `state.js` + 相关 `loadXxx()` 函数 |
| 新增页面 | `App.js` (路由) + `Sidebar.js` (导航) + `state.js` (`TAB_HEADINGS`) |
| 新增 CSS 文件 | `index.html` (link 标签) |
| 新增 i18n 键 | `i18n.js` 中对应 section |
| 新增 API 调用 | `api.js` (loader) + `server.js` (路由) |

---

## 附录 A: localStorage 键

| 键 | 类型 | 用途 |
|----|------|------|
| `boos.sidebar-collapsed` | bool | 侧边栏折叠 |
| `boos.sidebar-width` | number | 侧边栏宽度 |
| `boos.accent` | string | 主题色 |
| `boos.theme` | string | 主题模式 |
| `boos.folders-collapsed` | JSON | 文件夹折叠状态 |
| `boos.active-session-id` | string | 当前活跃 session |
| `boos.open-session-tabs` | JSON | 打开的 tab 列表 |
| `boos.folders-cache` | JSON | 文件夹缓存 (首次渲染) |
| `boos.sessions-cache` | JSON | sessions 缓存 |
| `boos.token` | string | 远程访问 token |
| `boos.deviceId` | string | 设备 ID |
| `boos.deviceCode` | string | 4位验证码 |
| `boos.workspace-layout.*` | JSON | 画布布局 (按 workspace 名) |

## 附录 B: API 端点

| 方法 | 路径 | 前端调用位置 |
|------|------|-------------|
| GET | `/api/config` | `api.js: loadConfig()` |
| PUT | `/api/config` | `api.js: updateCli/createCli/...` |
| GET | `/api/sessions` | `api.js: loadSessions()` |
| POST | `/api/sessions/new` | `streaming.js: streamNewSession()` |
| POST | `/api/sessions/:id/resume` | `api.js: resumeSession()` |
| DELETE | `/api/sessions/:id` | `api.js: deleteSession()` |
| GET | `/api/folders` | `api.js: loadFolders()` |
| GET | `/api/workspaces` | `api.js: loadWorkspaces()` |
| GET | `/api/health` | `api.js: pollHealth()` |
| WS | `/ws/terminal/:id` | `TerminalInstance.js: _connect()` |
