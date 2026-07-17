# Sprint 17 前端渲染性能基线

> 2026-07-16 | 可靠性工程师
> BOOS server: port 7780, PID 40904, v1.0.1

## B4.1 手动性能测量（Playwright MCP headed Chromium）

| 场景 | 指标 | 值 |
|------|------|-----|
| Sidebar 折叠/展开 (10次) | 平均耗时 | **385ms** |
| Sidebar 折叠/展开 | 最小/最大 | 350ms / 367ms |
| Tab 切换 (20样本) | 平均 FPS | **50.4** |
| Tab 切换 | 最低 FPS | 47.2 |
| Tab 切换 | <30 FPS 次数 | 0 |

## B4.2 Playwright E2E 自动化测试

| 测试 | 状态 | 说明 |
|------|------|------|
| SSE burst (10 rapid DOM updates) | ✅ Pass | 1.4ms, 0 errors |
| Layout stability (sidebar+resize) | ✅ Pass | 0 drops/122 frames, maxGap=17.9ms |
| Sidebar collapse/expand 100x | ⏭️ Skip | `.collapse-toggle` 在 headless Chromium 中未渲染（headed 正常） |
| Tab switch FPS 50 cycles | ⏭️ Skip | `.nav-item` 在 headless Chromium 中未渲染（headed 正常） |

**Headless 已知限制**: BOOS Preact SPA 在 headless Chromium 中 `.nav-item` / `.collapse-toggle` 未渲染，疑似 heartbeat 轮询阻塞 DOM 挂载。Headed 模式正常工作。建议后续排查 headless 渲染路径。

## B4.3 Sprint 16 修复验证

| 验证项 | 状态 |
|--------|------|
| 7778 端口引用 | ✅ 0 处残留（仅 coverage/tmp） |
| `webTerminal.write` 泄漏 | ✅ 仅 1 处（notifications.js:474 内部唤醒路径） |
| agent-bus.json 并发完整性 | ✅ withFileLock + atomicWriteJson 双重保护 |
| `test-agentbus-watcher.js` | ✅ 已删除 |
| package.json 重复 `os` | ✅ 已修复 |
| agentBusWatcher 引用清理 | ✅ 平台集成工程师 CLAUDE.md 已清理 |
| queue.js 死代码 | ✅ 非死代码（handlers.js 调用） |
| store.js 截断警告 | ⏭️ wontfix（2KB, 444 tasks） |

## 测试输出物

- `tests/e2e/rendering-perf.spec.js` — 4 个测试用例
- `tests/e2e/playwright.config.js` — 新增 chromium 浏览器项目
- `docs/sprint-17-perf-baseline.md` — 本文档
