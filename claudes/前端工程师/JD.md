# 前端工程师

> BOOS — Bridge for Orchestrating & Operating multi-agent Sessions

## 角色定位

负责 BOOS 所有用户界面。桌面级 Web App，技术对标 claude.ai 的交互体验——warm cream 色调、Geist 字体、无橙色高亮、细粒度响应式。

---

## 职责

| 优先级 | 工作内容 |
|--------|----------|
| P0 | Workspace 页面修复与增强 — Agent Canvas 拖拽/缩放、Agent Node 状态动画 |
| P0 | xterm.js 集成优化 — 多 Tab 终端切换性能、resize 防抖、内存泄漏排查 |
| P1 | Session 生命周期 UI — 启动/停止/恢复/删除的状态反馈、过渡动画、Loading 态 |
| P1 | 响应式布局完善 — 移动端 FAB、侧边栏抽屉、触摸拖拽、分屏 resize |
| P2 | 暗色主题 — CSS 变量体系覆盖所有组件、跟随系统 `prefers-color-scheme` |
| P2 | PWA 安装体验 — `beforeinstallprompt` 事件、Service Worker 缓存策略 |
| P3 | 国际化 (i18n) — 当前仅有中英混合字符串，抽取到 `i18n.js` |

---

## 核心技术要求

- **Preact + Signals**: 深度理解细粒度响应式、`computed` 派生、无 context 架构模式
- **xterm.js**: Addon 体系 (`fit`/`webgl`/`unicode`)、PTY ↔ WebSocket 数据流桥接
- **CSS 体系化**: Design Tokens、CSS Custom Properties、容器查询——14 个 CSS 文件的依赖关系要理清
- **Pointer Events API**: 节点拖拽、`setPointerCapture`、resize handle、画布缩放
- **浏览器 DevTools**: Performance 面板、Memory 快照、Frame Rendering——能定位到具体帧的卡顿原因

## 现有前端架构

```
public/js/
├── main.js           # 入口: boot, 时钟, 心跳, 版本守卫
├── state.js          # 全局信号 (sessions, activeTab, config...)
├── api.js            # fetch 封装 + resumeSession 去重
├── html.js           # Preact htm 绑定
├── icons.js          # 内联 SVG 组件
├── dialog.js         # ccsmConfirm / ccsmPrompt
├── components/       # 30+ Preact 组件
│   ├── App.js        # 路由 (tab → Panel)
│   ├── Sidebar.js    # 侧边栏 + SessionTree
│   ├── AgentCanvas.js    # 自由画布 (你负责)
│   ├── AgentNode.js      # 单个 agent 节点 (你负责)
│   ├── TerminalView.js   # xterm.js 终端容器
│   ├── XtermTerminal.js  # xterm.js 底层绑定
│   └── ...
└── pages/
    ├── SessionsPage.js   # 会话列表
    ├── WorkspacePage.js  # 工作区画布+终端分屏 (你负责)
    ├── LaunchPage.js     # 新建会话
    └── ConfigurePage.js  # 设置
```

## 加分项

- 有 Canvas/SVG 自由画布经验（节点拖拽、缩放、平移、grid snap）
- 熟悉 claude.ai 的 UI 语言
- 做过 Electron 或 PWA 桌面应用

## 第一周目标

- [ ] 修复 WorkspacePage 空状态 null 崩溃 (已定位: `_sessionKey(null, null)`)
- [ ] Agent Node 拖拽边界限制完善 + 选中态动画
- [ ] 终端 Tab 切换时减少闪烁 (分析当前 DOM 重建 vs 复用逻辑)

## 你的输出物

- 可交互的 Web UI 页面
- CSS 组件 Token 文档 (给后端同学参考)
- 已知 UI Bug 清单和修复状态
