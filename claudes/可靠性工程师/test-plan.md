# BOOS 测试策略与规范

> 可靠性工程师 · 2026-07-13 · v1.0

## 1. 测试体系总览

```
               ┌─────────────────────┐
               │    E2E (Playwright) │  ← 关键用户路径
               │        ~5%          │
               ├─────────────────────┤
               │  Integration (API)  │  ← REST + WebSocket
               │       ~15%          │
               ├─────────────────────┤
               │  Unit (node:test)   │  ← 核心 lib 全覆盖
               │        ~80%         │
               └─────────────────────┘
```

| 层级 | 工具 | 目标覆盖率 | 运行策略 |
|------|------|-----------|----------|
| **单元测试** | `node:test` + `assert` | ≥80% statements | 每次 push 自动运行 |
| **集成测试** | `node:test` + supertest-ws | ≥60% API 端点 | PR 到 main 时运行 |
| **E2E 测试** | Playwright | 核心 5 条路径 | 每日定时 + 发布前 |
| **压测** | k6 / autocannon | throughput + p95 | 按需运行 |
| **覆盖率报告** | c8 | — | 合并到 CI 制品 |

## 2. 覆盖率目标（渐进式）

| 阶段 | 时间 | 目标 |
|------|------|------|
| **Phase 1 — 奠基** | 第 1 周 | 10+ test cases, lib/ 核心文件覆盖 |
| **Phase 2 — 覆盖** | 第 2–3 周 | lib/ 目录 ≥60% statements |
| **Phase 3 — 全面** | 第 4–6 周 | 整体 ≥80% statements |
| **Phase 4 — 持续** | 长期 | 维持 ≥80%，新代码要求 ≥90% |

## 3. 测试文件约定

```
tests/
├── lib/                          ← 单元测试：与 lib/ 一一对应
│   ├── atomicJson.test.js
│   ├── jsonStore.test.js
│   ├── persistedSessions.test.js
│   ├── webTerminal.test.js
│   ├── workspace.test.js
│   ├── config.test.js
│   ├── folders.test.js
│   ├── sessionBinding.test.js
│   ├── cliActivity.test.js
│   ├── localCliSessions.test.js
│   ├── winPath.test.js
│   ├── devices.test.js
│   ├── codexSeed.test.js
│   ├── tunnel.test.js
│   └── agentBusWatcher.test.js
├── integration/                  ← 集成测试：API + WebSocket
│   ├── api-sessions.test.js
│   ├── api-config.test.js
│   ├── ws-terminal.test.js
│   └── lifecycle.test.js
├── e2e/                          ← 端到端测试
│   ├── launch-flow.spec.js
│   ├── session-resume.spec.js
│   └── sidebar-navigation.spec.js
└── fixtures/                     ← 测试数据
    ├── sessions.json
    └── config.json
```

## 4. 测试编写规范

### 4.1 命名

- 文件名: `<module>.test.js`
- Test name: 描述行为而非实现 — `'load() returns {} for missing file'` 而非 `'test load 1'`

### 4.2 结构

```js
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('ModuleName', () => {
  // Arrange → Act → Assert
  test('should <expected behavior> when <condition>', async () => {
    // ...
  });
});
```

### 4.3 隔离

- 所有文件 I/O 使用 `os.tmpdir()` + 随机子目录
- `beforeEach` 创建临时目录，`afterEach` 清理
- 不依赖全局状态、环境变量（除非被测代码要求）

### 4.4 边界 case 清单（每个模块必修）

- [ ] 空输入 / 缺失参数
- [ ] 并发写入（Promise.all）
- [ ] 异常路径（文件不存在、权限不足、磁盘满）
- [ ] 大文件 / 大量条目
- [ ] 特殊字符（Unicode、换行符、JSON 元字符）

## 5. CI/CD 流水线

```
Push to main ──→ test.yml (6 matrix jobs)
PR to main   ──→ test.yml + lint
Tag v*       ──→ test.yml + publish
Schedule     ──→ E2E daily + k6 weekly
```

### 5.1 矩阵

| OS | Node.js | 目的 |
|----|---------|------|
| ubuntu-latest | 20, 22 | Linux 验证 |
| windows-latest | 20, 22 | Windows 核心平台 |
| macos-latest | 20, 22 | macOS 兼容性 |

## 6. E2E 选型

### 6.1 为什么 Playwright

| 对比维度 | Playwright | Cypress | Selenium |
|----------|-----------|---------|----------|
| 多浏览器 | ✅ Chromium + Firefox + WebKit | ❌ Chrome only | ✅ |
| Windows 支持 | ✅ 一等公民 | ⚠️ 有限 | ✅ |
| WebSocket 测试 | ✅ route mocking | ⚠️ | ❌ |
| CI 集成 | ✅ 内置 reporter | ✅ | ⚠️ |
| PTY/xterm.js | ✅ evaluate() | ⚠️ | ❌ |

### 6.2 E2E 目标路径（5 条）

1. **启动 → 创建 Session → 终端交互** — 核心启动流程
2. **Session 恢复** — resume / continue / picker 三种模式
3. **侧边栏拖拽排序** — 文件夹管理
4. **设置页面** — 配置读取/保存
5. **离线检测** — 后端断开时的 UI 反馈

## 7. 压测方案

| 场景 | 工具 | 目标 |
|------|------|------|
| 并发 Session 创建 | k6 | 20 并发 ≤ 2s |
| WebSocket 广播 | autocannon | 100 连接 ≤ 5s 延迟 |
| 终端 I/O 吞吐 | 自研 | 10MB/s ≥ 稳定 |
| 内存泄漏检测 | Node.js heap snapshots | 24h 运行 ≤ 200MB |

## 8. 当前进度

| 模块 | 测试文件 | Cases | 状态 |
|------|---------|-------|------|
| `jsonStore.js` | `tests/jsonStore.test.js` | 12 | ✅ 全部通过 |
| `atomicJson.js` | `tests/atomicJson.test.js` | 8 | ✅ 全部通过 |
| `persistedSessions.js` | — | 0 | 🔲 待测 |
| `webTerminal.js` | — | 0 | 🔲 待测 |
| `workspace.js` | — | 0 | 🔲 待测 |
| `config.js` | — | 0 | 🔲 待测 |
| `folders.js` | — | 0 | 🔲 待测 |
| 其余 9 个 lib | — | 0 | 🔲 待测 |

**总计**: 20 test cases · 2 个模块覆盖 · CI 就绪
