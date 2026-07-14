# Sprint 6 Plan — v1.0.0 Release & 生产就绪

> PM: 全栈架构师_PM | 日期: 2026-07-13 | 周期: 2 天

---

## 主题

**v1.0.0 正式发布** — 从"功能完备"到"生产就绪"

当前状态: 73 任务完成，server.js 496 行（-78%），173 tests pass，agent-bus 嵌入式运行中。

---

## 目标

| 目标 | 衡量标准 |
|------|----------|
| v1.0.0 Release | CHANGELOG + git tag + GitHub Release draft |
| 冒烟测试 100% | 9/9 API endpoints + WebSocket + agent-bus health |
| 跨平台验证通过 | macOS/Linux install 脚本 CI 全绿 |
| 文档同步 | architecture.md / backlog.md / README.md 更新至当前状态 |
| Agent-Bus 生产就绪 | 4 agent 注册 + 任务派发 + inbox 轮询 E2E 验证 |

---

## Sprint 6 任务

### P0: Release 准备 (PM)

| # | 任务 | 产出 | 估时 |
|---|------|------|:--:|
| 74 | CHANGELOG v1.0.0 — 汇总 Sprint 1-5 变更 | CHANGELOG.md 更新 | 30m |
| 75 | git tag v1.0.0 + GitHub Release draft | tag + release notes | 15m |
| 76 | architecture.md 同步 — 更新 server.js 行数 / 路由文件数 | 文档更新 | 15m |
| 77 | 全链路 E2E 冒烟测试 — 启动 BOOS → 验证 API → agent-bus 任务收发 | 冒烟报告 | 1h |

### P1: 平台集成 (平台集成工程师)

| # | 任务 | 产出 | 状态 |
|---|------|------|:--:|
| 78 | macOS install-darwin.sh CI 验证 | CI 绿 | ✅ |
| 79 | Linux install-linux.sh CI 验证 | CI 绿 | ✅ |
| 80 | boos_terminal_list MCP tool — schema + handler | lib/mcp/tools.js +35 行 | ✅ |

### P1: 稳定性 (可靠性工程师)

| # | 任务 | 产出 | 状态 |
|---|------|------|:--:|
| 81 | CI unit-tests matrix 首次运行验证 | 3 OS × 2 Node = 6 jobs 绿 | ✅ |
| 82 | agent-bus 负载测试 — 50 tasks burst | 压测报告 | 🔄 |
| 83 | security audit — /mcp/* 端点权限复查 | audit checklist | ✅ |

### P2: 前端优化 (前端工程师)

| # | 任务 | 产出 | 状态 |
|---|------|------|:--:|
| 84 | 冒烟测试重跑 — 验证 9/9 endpoints | smoke-test-report.md v2 | 📋 |
| 85 | WorkspacePage + Agent Canvas agent-bus 集成验证 | 兼容性报告 | 📋 |
| 86 | Dark theme CSS variables 补完 | dark.css 完善 | 📋 |
| 88 | 🐛 UI 文字破碎修复 — xterm WebGL atlas | XtermTerminal.js + TerminalInstance.js | ✅ |
| 89 | 🎨 暗色模式终端调色板 — BOOS Muted Dark | XtermTerminal.js THEME_DARK | ✅ |

### P0: Session Resume 回退 Bug (PM) 🐛

| # | 任务 | 产出 | 状态 |
|---|------|------|:--:|
| 87 | 修复 binding scanner — detectClaude() projects/ fallback | sessionBinding.js Phase 2 | ✅ (diff 未 commit) |

### P0: Agent-Bus 增强 (PM) 🆕

| # | 任务 | 产出 | 状态 |
|---|------|------|:--:|
| 90 | TTL 禁用 — agent 默认不下线 | transport.js + registry.js | ✅ (未部署) |
| 91 | wake_agent MCP 工具 — 主动唤醒休眠 agent | schemas + handlers + notifications | ✅ (未部署) |
## 交付物

```
Sprint 6 产出:
├── git tag v1.0.0
├── GitHub Release (draft → published)
├── CHANGELOG.md v1.0.0
├── architecture.md (更新)
├── smoke-test-report.md v2
├── platform-audit.md (追加 E2E 结果)
└── agent-bus-load-test.md
```

---

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| npm publish 需 CI 环境 | 无法本地发版 | 已用 gh CLI + GitHub Actions |
| macOS/Linux runner 首次运行可能失败 | CI 红 | fail-fast: false，独立排查 |
| agent-bus 无实机 agent 连接 | 任务无法验收 | 用 curl + /api/call 模拟 E2E |

---

## Sprint 6 后

- **v1.0.1** — bugfix 周期
- **v1.1.0** — 跨平台正式支持（Windows/macOS/Linux 全部 CI 绿）
- **v2.0.0** — Agent Canvas 完整交互 + Supervisor DAG 可视化
