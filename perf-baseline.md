# BOOS 前端性能基准报告

> Sprint 17 B4 | 2026-07-17 | Playwright E2E 测量

## 测量环境

- **URL**: http://localhost:7780
- **浏览器**: Chromium (Playwright)
- **页面**: DecisionsPage（决策/任务仪表盘）

## 首次渲染 (First Paint)

| 指标 | 值 | 评估 |
|------|-----|------|
| First Paint (FP) | 356ms | ✅ 优秀 (<500ms) |
| First Contentful Paint (FCP) | 356ms | ✅ 优秀 (<500ms) |
| TTFB (首字节) | 49ms | ✅ 本地回环 |
| DOM Interactive | 104ms | ✅ 快速 |
| DOM Content Loaded | 1801ms | ⚠️ 偏慢 (Google Fonts) |
| Load Complete | 1802ms | ⚠️ 偏慢 |

## 侧边栏交互延迟

| 操作 | 延迟 | 评估 |
|------|------|------|
| 折叠 (expand → collapse) | 8ms | ✅ 优秀 |
| 展开 (collapse → expand) | 17ms | ✅ 优秀 |

## JS 内存 & DOM

| 指标 | 值 | 评估 |
|------|-----|------|
| JS Heap (used) | 6.0 MB | ✅ 轻量 |
| JS Heap (total) | 8.5 MB | ✅ 轻量 |
| DOM Node Count | 393 | ✅ 合理 |

## Sprint 17 性能优化总结

| 任务 | 优化 | 效果 |
|------|------|------|
| B1 (P0) | SSE rAF batch merge | 单帧内多次 SSE 事件只触发一次 Preact re-render |
| B2 | ResizeObserver rAF debounce | 消除 sidebar resize → xterm → resize 循环 |
| B3 | CSS contain + will-change | sidebar GPU 合成层，terminal-host contain layout style paint |
| A5 | 任务表格优化 | contain layout style 隔离表格 reflow |
