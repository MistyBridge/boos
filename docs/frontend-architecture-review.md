# BOOS 前端架构概览 (Phase 1 — Sprint 26)

> 调研日期: 2026-07-27 · 调研人: 前端工程师-A3

---

## 1. 组件树 (从 App.js 往下)

```
index.html
├── <script> 内联主题计算 (FOUC 防护)
├── importmap (preact, htm, @xterm/*)
├── <link> 16 个 CSS 文件 + Google Fonts
├── <script type="module" src="./js/main.js">
│   └── main.js (入口)
│       ├── URL token 提取 + deviceId 初始化
│       ├── loadPersisted() → localStorage rehydrate
│       ├── bootVersionGuard() → 版本路由 guard
│       ├── /api/devices/me → pendingDevice 判断
│       ├── loadConfig() + refreshAll() → 加载数据
│       ├── setInterval 5s/15s 轮询 (sessions/folders/workspaces)
│       ├── setInterval 10s 心跳 → /api/heartbeat
│       ├── 全局 SSE → agent-bus activity 桥接
│       └── render(<App />, #app)
│
└── App.js (路由根组件)
    ├── Sidebar.js (侧边栏导航)
    │   ├── BrandMark (BOOS logo → 导航到 About)
    │   ├── NavItem × 6 (Launch / 工作区 / 决策区 / 目标 / Remote / 设置)
    │   ├── SessionTree
    │   │   ├── SearchBar (过滤搜索)
    │   │   ├── HR Agent 独立条目
    │   │   ├── FolderGroup × N (文件夹分组)
    │   │   │   ├── FolderHead (折叠/展开 + 操作按钮)
    │   │   │   └── SessionRow × N (每个会话行)
    │   │   │       ├── 状态圆点 (running/idle/working 动画)
    │   │   │       ├── 标题 + 操作按钮 (重命名/删除)
    │   │   │       └── 时间戳 (fmtAgo)
    │   │   ├── DeletedSessionsGroup
    │   │   │   └── DeletedSessionRow (恢复按钮)
    │   │   └── ImportById (导入会话表单)
    │   ├── CollapseToggle (侧边栏收展)
    │   ├── PWA 安装按钮
    │   └── ResizeHandle (拖拽调整宽度)
    │
    ├── Panel × 9 (tab-panel, 通过 CSS display:none 路由)
    │   ├── sessions → SessionsPage
    │   │   ├── PageTitleBar (标题栏)
    │   │   ├── SessionTabs (可拖拽排序的标签页)
    │   │   │   ├── SessionControls (停止/恢复按钮)
    │   │   │   └── SessionMenu (kebab 菜单)
    │   │   │       └── Popover (CLI 切换/重命名/删除)
    │   │   └── SessionPane
    │   │       └── TerminalStack (多层 terminal-layer)
    │   │           └── TerminalView × N
    │   │               ├── TerminalHostAnchor (Preact 管理)
    │   │               │   └── TerminalHost (raw DOM, 非 Preact)
    │   │               │       └── XtermTerminal 实例 (xterm.js)
    │   │               ├── ReconnectOverlay
    │   │               └── TerminalKeyBar (移动端辅助键栏)
    │   │
    │   ├── workspace → WorkspacePage
    │   │   └── AgentCanvas (拖拽/缩放节点画布)
    │   │       ├── AgentNode × N
    │   │       └── TerminalView (底部终端面板)
    │   │
    │   ├── launch → LaunchPage
    │   │   └── LaunchHero
    │   │       ├── Picker × 3 (CLI / 工作目录 / 文件夹)
    │   │       │   ├── PickerPanel (统一选择器)
    │   │       │   ├── Modal (弹窗外壳)
    │   │       │   └── DirectoryPicker (目录浏览)
    │   │       ├── ProgressList (克隆进度)
    │   │       └── LoadSessionModal (加载已有会话)
    │   │
    │   ├── configure → ConfigurePage
    │   │   └── (CLI 配置 / 仓库管理 / 主题设置)
    │   │
    │   ├── remote → RemotePage
    │   │   └── (隧道/设备管理 — 仅 loopback)
    │   │
    │   ├── about → AboutPage
    │   │   └── (版本信息 / 升级按钮)
    │   │
    │   ├── decisions → DecisionPage
    │   │   ├── StatItem × 3 (待处理/紧急/已推迟)
    │   │   ├── BatchToolbar (批量操作)
    │   │   └── Card(flush) → DecisionCard × N
    │   │
    │   └── goals → GoalPage
    │       ├── StatItem × 3 (草稿/进行中/已完成)
    │       └── GoalCard × N (可展开)
    │
    ├── Toast (底部浮层通知)
    ├── DialogHost (确认/输入模态框)
    ├── HealthOverlay (启动时健康检查)
    ├── RestartOverlay (重启中遮挡)
    ├── PendingApprovalOverlay (远程设备审批)
    └── MobileNavFab (移动端导航 FAB)
```

---

## 2. 数据流

```
┌──────────────┐   fetch(apiAuthHeaders)   ┌──────────────┐
│   api.js     │ ◄───────────────────────► │  Backend     │
│   (fetch封装) │        /api/*             │  server.js   │
└──────┬───────┘                           └──────────────┘
       │ 写入 Signal
       ▼
┌──────────────┐
│  state.js    │  -- Signal 响应式订阅 ──►  All Components
│  30+ signals │
└──────────────┘
       ▲
       │ computed() 派生
┌──────────────┘
│  sessionsByFolder (分文件夹分组)
│  pendingDecisionCount (决策计数)
│  taskCount (任务计数)
│  hrAgentSession (HR Agent 过滤)
│  TAB_HEADINGS (页面元数据)
└──────────────────────────────

数据刷新节奏:
  ┌──────────┬───────────────┬─────────────────────┐
  │ 频率     │ 请求           │ 模式                │
  ├──────────┼───────────────┼─────────────────────┤
  │ 5s       │ sessions,      │ 本地访问 (loopback) │
  │          │ deletedSessions│ 全量刷新            │
  │          │ folders,       │                     │
  │          │ workspaces,    │                     │
  │          │ tasks          │                     │
  ├──────────┼───────────────┼─────────────────────┤
  │ 15s      │ 同上           │ 远程访问 (tunnel)   │
  │ 10s      │ heartbeat      │ 存活检测 + 多客户端 │
  │          │                │ 生命周期 guard      │
  │ 30s      │ decisions      │ 决策区徽章计数       │
  │          │ (Sidebar 独立) │                     │
  │ 30s      │ WebGL atlas 刷新│ xterm.js 纹理重建   │
  ├──────────┼───────────────┼─────────────────────┤
  │ 实时     │ SSE            │ agent-bus 活动事件   │
  │ (EventSour│ /api/agents/   │ → workspaceAgent-   │
  │  ce)     │ events         │   Activity + sessions│
  └──────────┴───────────────┴─────────────────────┘

Signal 写入优化 (Sprint 18 P2):
  - loadSessions/loadFolders/loadWorkspaces/loadTasks 均有浅比较
  - JSON.stringify(next) !== JSON.stringify(signal.value) → 跳过写入
  - 避免不必要的组件树重渲染

SSE → Signal 批处理 (Sprint 17 B1):
  - subscribeAgentEvents → 50ms debounce → rAF flush
  - pendingActivity 累积 → 一次性写入 workspaceAgentActivity + sessions
  - pendingDirty flag 标记进行中的批次
```

---

## 3. 终端架构

```
SessionsPage
  └── terminal-stack (position: absolute; inset:0)
      └── terminal-layer (visibility/opacity 切换)
          └── TerminalView (Preact 组件)
              └── terminal-host-anchor (Preact DOM, contain:strict)
                  └── terminal-host (raw document.createElement, 非 Preact vDOM)
                      └── XtermTerminal 实例
                          ├── Terminal (xterm.js 5.5.0)
                          ├── FitAddon (自适应尺寸)
                          ├── WebLinksAddon (链接检测)
                          ├── ClipboardAddon (剪贴板)
                          └── WebglAddon (GPU 渲染, 移动端回退 DOM)

关键设计决策:
  - 终端 host div 通过 raw DOM 创建，Preact 永不触及此子树
  - Tab 切换: CSS visibility + opacity，不 mount/unmount
  - GPU 合成: transform:translateZ(0) + will-change:contents
  - scrollback=2000: 控制 resize 时 WebGL 纹理重建成本
  - WebGL context lost → 自动回退 DOM 渲染器
  - resize 时保存/恢复滚动位置 (单 rAF, 非三段链)
  - 30s atlas 刷新 (requestIdleCallback, 输出流式时跳过)

终端主题:
  - THEME_LIGHT: VSCode Light+ 配色
  - THEME_DARK: BOOS Muted Dark 自定义配色
  - JS theme 对象 + CSS 终端 chrome tokens 分开管理
```

---

## 4. CSS 架构

```
tokens.css         ← 设计令牌 (CSS Custom Properties)
  ├── 表面色: --bg, --bg-elev, --sidebar-bg
  ├── 强调色: --accent, --accent-deep, --accent-soft, --accent-softer
  ├── 墨色: --ink, --ink-mid, --ink-muted, --ink-faint
  ├── 状态色: --green, --red, --blue, --yellow
  ├── 间距: --s-1 … --s-16
  ├── 圆角: --r-sm, --r, --r-md, --r-lg
  ├── 阴影: --shadow-sm, --shadow, --shadow-md, --shadow-lg
  └── 字体: --body (Geist), --mono (JetBrains Mono)

  ↓ 运行时动态覆盖 (state.js applyAccentCssVars)
  ↓ 用户选择 accent color → 重新派生整个调色板

base.css           ← 重置 + 全局排版 + 滚动条
layout.css         ← App 网格 (.app grid) + .page-title-bar
sidebar.css        ← 侧边栏全部 (580+ 行, 最大单文件)
cards.css          ← 卡片 + 决策卡片 + 任务表格 + TaskDashboard
tables.css         ← 表格样式
forms.css          ← 按钮(.action) + 输入 + chip + radio + 配置网格
widgets.css        ← 工作区卡片 + 进度条 + 分页 + 状态标记
feedback.css       ← Toast + 离线遮挡 + 脏标记 + 健康检查
modal.css          ← 模态框 + FAB + 对话框
loadsession.css    ← 加载会话模态框
terminals.css      ← 终端窗格 + 标签页 + 移动端键栏 + 重连
wco.css            ← PWA 窗口控件叠加层 + 拖拽区域
workspace.css      ← Agent Canvas 样式
responsive.css     ← 响应式断点 (900/768/640px)
dark.css           ← [data-theme="dark"] 覆盖 (末位加载)

总计: 16 个 CSS 文件, 约 3500 行
组织方式: 按功能域分割 (每个 .css 对应一类 UI)
无需构建工具: 浏览器原生 importmap + CSS link
版本控制: URL 查询参数 ?v=1.1.0 做缓存爆破
```

---

## 5. Service Worker

```
CACHE_NAME = 'boos-v3'
策略: cache-first (静态) + network-only (API)

安装:
  pre-cache: /, /index.html, /favicon.svg, /manifest.webmanifest

激活:
  删除所有非当前版本的缓存

fetch:
  /api/* 或 /ws/* → 直接网络, 不缓存
  其他请求:
    1. 尝试 cache.match() → 命中返回缓存
    2. 未命中 → fetch() → 成功则 cache.put()
    3. 网络失败 → 导航请求返回 /index.html, 其他返回 408

问题: cache-first 意味着新版本文件在 SW 激活前不会更新
     skipWaiting() + clients.claim() 缓解, 但仍有窗口期
     CSS/JS 的 ?v= 查询参数在 SW 缓存查找时有效
```

---

## 6. 已有问题清单 (阅读发现)

### P0 — 影响用户体验

| # | 问题 | 位置 | 严重度 |
|---|------|------|--------|
| 1 | **SW cache-first 旧文件滞留**: `CACHE_NAME` 从 'boos-v1' → 'boos-v2' → 'boos-v3', 但 `activate` 阶段删除旧缓存仅在新 SW 安装后执行。用户可能在旧 SW 控制下看到旧版 UI, 直到新 SW `skipWaiting` + `claim` 完成。CSS 文件虽有 `?v=1.1.0` 查询参数, 但 cache.match() 会匹配带查询参数的 URL | `sw.js:4-5` | 高 |
| 2 | **xterm.js resize WebGL 撕裂**: `scrollback: 2000` 是折衷值。注释说明"更高值导致 WebGL atlas 重建撕裂"。如果用户在终端输出很多内容后 resize 窗口, WebGL 仍需重建纹理图集, 导致短暂视觉闪烁 | `XtermTerminal.js:82` | 高 |
| 3 | **`contain: strict` 可能引发高度塌陷**: `terminal-host-anchor` 和 `terminal-host` 均有 `contain: strict`。当内部 xterm canvas 的实际渲染尺寸与 CSS box 不匹配时(例如 DPR 变化), 高度计算可能出错 | `terminals.css` + `TerminalView.js:113` | 中 |

### P1 — 技术债 / 设计问题

| # | 问题 | 位置 | 严重度 |
|---|------|------|--------|
| 4 | **无全局错误边界**: 任何组件 throw → 整个 App 崩溃。`api()` 有 try-catch, 但渲染阶段的错误无保护 | 全局 | 高 |
| 5 | **Signal 细粒度订阅问题**: `clockTick.value` 在多个组件的 render 函数顶层访问(非 hook), 导致这些组件在每个 clockTick 变化时都重渲染。Sprint 18 P2 已从每秒改为每分钟, 但仍有不必要的重渲染 | `state.js`, 各组件 | 中 |
| 6 | **XtermTerminal 是类而非 Preact 组件**: 434 行 ES6 class, 手动管理生命周期。与 Preact 生态集成靠 `TerminalInstance` 桥接。测试困难(纯 JS class) | `XtermTerminal.js` | 中 |
| 7 | **API 层混合关注点**: `api.js` (600+ 行) 同时包含 fetch 封装、signal 写入、dedup 逻辑、SSE 订阅、健康检查。职责边界模糊 | `api.js` | 中 |
| 8 | **Sidebar.js 单体巨大**: 约 550 行, 包含 NavItem, SessionRow, DeletedSessionRow, FolderGroup, SessionTree, ImportById, Sidebar 共 7 个组件定义。拖拽逻辑(session ↔ folder, folder ↔ folder)交织在一起 | `Sidebar.js` | 中 |
| 9 | **CSS 文件引入方式**: 16 个 `<link>` 标签, 无 bundling/压缩。首次加载需要 16 次 HTTP 请求(GH Pages 场景, 本地 dev 也有 DNS 预热成本) | `index.html` | 低 |
| 10 | **多终端层 DOM 开销**: terminal-stack 即使不可见层也保留在 DOM 中。每层持有自己的 xterm.js 实例(WebGL 上下文), 对资源有压力 | `SessionsPage.js`, `TerminalView.js` | 低 |

### P2 — 优化/完善

| # | 问题 | 位置 | 严重度 |
|---|------|------|--------|
| 11 | **无前端错误日志/上报**: console 输出只到浏览器控制台, 无 Sentry/Datadog 等 | 全局 | 中 |
| 12 | **无单元测试**: 代码库中无 `*.test.js` 文件 | 全局 | 中 |
| 13 | **JSON.stringify 比较性能**: `loadSessions`/`loadFolders` 等每次轮询都做完整 JSON.stringify 比较, 针对大 session 列表可能有性能开销 | `api.js` | 低 |
| 14 | **Hardcoded 字符串**: 部分 UI 文本直接写中文(如 "批量操作", "全选"), 不在 i18n.js 中 | `DecisionPage.js:111-112` | 低 |

---

## 7. 代码质量评估

### 模块化程度: ★★★★☆ (良好)

- 按页面/组件/库清晰分层
- 单一入口 `main.js` → 明确初始化顺序
- 每个页面约 150-300 行, 组件约 50-100 行
- **扣分项**: `api.js` 和 `Sidebar.js` 过大, 需拆分

### 可维护性: ★★★☆☆ (中等)

- Preact Signals 的细粒度响应式降低 mental overhead
- CSS Design Tokens 体系使全局样式变更安全
- 注释质量高(英文, 解释 why 而非 what)
- **扣分项**: 无类型检查(纯 JS), IDE 无法提供智能提示; 类组件(XtermTerminal)与函数组件并存

### 性能: ★★★★☆ (良好)

- Signal 浅比较避免无效渲染
- 终端 raw DOM 绕开 vDOM 开销
- GPU 合成 + contain 隔离布局
- SSE batch 50ms debounce
- **扣分项**: 16 个 CSS 文件无 bundling; terminal-stack 多实例

### 类型安全: ★★☆☆☆ (不足)

- 零 TypeScript / JSDoc 类型注解
- API 返回形状无验证
- 依赖运行时 `Array.isArray()` / `typeof` 守卫

### 测试覆盖: ★☆☆☆☆ (严重不足)

- 无单元测试
- 无 E2E 测试(尽管 Playwright MCP 可用)
- 无视觉回归测试

---

## 8. 启动链

```
1. index.html 内联 <script>
   ├── 读取 localStorage(boos.accent, boos.theme)
   ├── 计算 accent 派生调色板
   ├── 写入 CSS Custom Properties → FOUC 防护
   └── 设置 data-theme 属性

2. importmap 解析 (preact, htm, xterm, ...)

3. main.js 模块加载
   ├── URL token 提取 + deviceId
   ├── loadPersisted() → localStorage rehydrate
   │   ├── sidebarCollapsed, sidebarWidth, accentColor, themeMode
   │   ├── foldersCache, sessionsCache, deletedSessionsCache
   │   └── openSessionTabs, activeSessionId, URL hash
   ├── installGlobalKeybindings()
   ├── document.title 响应式 effect
   ├── render(<App />, #app)
   ├── PWA install prompt 捕获
   ├── display-mode 检测 → body.is-app / .is-wco
   ├── 移动端 MQ 检测 → isMobile signal
   ├── anti-zoom 计算 → --anti-zoom CSS var
   ├── WCO titlebar height → --titlebar-h CSS var
   ├── visualViewport 高度 → --app-vh CSS var
   ├── bootVersionGuard() → 版本不匹配 → location.replace('../')
   ├── /api/devices/me → pendingDevice 判断
   ├── loadConfig() + refreshAll()
   ├── pollHealth()
   ├── setInterval 5s/15s 数据刷新
   ├── setInterval 10s 心跳
   └── SW 注册 (/sw.js)
```
