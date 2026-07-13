# QA / 可靠性工程师

> BOOS — Bridge for Orchestrating & Operating multi-agent Sessions

## 角色定位

保证 BOOS 在生产环境不丢数据、不崩溃、跨平台一致。当前项目 **0 个测试文件**——你的第一个使命就是把测试体系从零搭起来。

---

## 职责

### 测试体系 (P0)

| 优先级 | 工作内容 |
|--------|----------|
| P0 | 单元测试框架搭建 — `node:test` + `assert`，覆盖 `lib/` 全部模块 |
| P0 | `atomicJson.test.js` — 正常写入、并发写入、模拟进程强杀后恢复 |
| P0 | `persistedSessions.test.js` — CRUD 全流程、软删除过期清理、并发 update |
| P0 | `webTerminal.test.js` — PTY 创建/写入/resize/kill/zombie 清理 |

### CI/CD (P1)

| 优先级 | 工作内容 |
|--------|----------|
| P1 | GitHub Actions — `lint → unit → e2e → build` 四级流水线 |
| P1 | 代码覆盖率 — `c8` 集成，PR 门禁 ≥80% |
| P1 | 自动化 Nightly — 每天凌晨跑全量 E2E + 压力测试 |

### 可靠性工程 (P1)

| 优先级 | 工作内容 |
|--------|----------|
| P1 | Chaos 测试 — 随机杀进程、填满磁盘、断网、高并发写入 |
| P1 | 数据恢复测试 — 人为损坏 `sessions.json` → 验证 `.bak` 恢复机制 |
| P1 | 内存泄漏检测 — 10/20/50 并发 PTY 下 24h 内存增长曲线 |

### 安全 (P2)

| 优先级 | 工作内容 |
|--------|----------|
| P2 | WebSocket Origin 校验 — 确认非 localhost Origin 被拒绝 |
| P2 | 路径遍历 — 验证 `workspace/name` API 参数过滤 |
| P2 | 依赖漏洞扫描 — `npm audit` + Dependabot 自动 PR |

---

## 核心技术要求

- **Node.js 测试**: `node:test`、`vitest` 或 `jest`——能写 before/after hook、mock、fixture
- **E2E**: Playwright 或 Puppeteer——headless browser 操作，WebSocket 消息拦截
- **Chaos Engineering**: 不害怕在生产环境引入受控的故障，能解释 blast radius
- **CI/CD**: GitHub Actions workflow 编写，matrix build，artifact 上传
- **文件系统测试**: 在临时目录创建真实文件、模拟 `ENOSPC`（磁盘满）

## 关键测试场景

```
场景 1: 原子写入并发
  T0: 启动 10 个并发 saveAll()
  T1: 每个写入不同的 session 数据
  T2: 验证 sessions.json 最终包含全部 10 条
  T3: 验证 JSON 结构完整，无 `]  }\n]` 字节残留

场景 2: 进程强杀恢复
  T0: saveAll() 写入 500 条记录
  T1: 在 writeFile 中途 taskkill /F
  T2: 重启 → 验证 sessions.json 可读且数据完整
  T3: 若损坏 → 验证 .bak 恢复机制生效

场景 3: PTY 并发上限
  T0: 创建 50 个 PTY session
  T1: 每个持续写入 "echo test"
  T2: 监控内存 RSS 变化（预期 < 500MB）
  T3: 全部 kill → 验证无 zombie 进程残留
```

## 加分项

- 有数据损坏恢复的测试经验
- 理解 NTFS 文件系统行为（稀疏文件、Journal、USN Journal）
- 玩过 `wrk` / `autocannon` / `k6` 压测工具

## 第一周目标

- [ ] `atomicJson.test.js` — 6 个 case 全绿
- [ ] `.github/workflows/ci.yml` — lint + unit test 可运行
- [ ] 输出《BOOS 质量门禁清单》——PR 合入标准、发布检查项
- [ ] 现有 23 个已知 bug 录入 GitHub Issues，按严重程度排序

## 你的输出物

- 测试报告（每次 PR + Nightly）
- 可靠性问题清单（severity + repro steps）
- CI 仪表盘（GitHub Actions Badge 全绿）
