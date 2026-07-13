# Tech Lead / 全栈架构师 (兼 PM)

> BOOS — Bridge for Orchestrating & Operating multi-agent Sessions

## 角色定位

技术决策者 + 后端核心开发者 + 团队 PM。是整个团队唯一同时拥有"架构决定权"和"产品方向决定权"的人。

---

## 职责

### 技术 (70%)

| 优先级 | 工作内容 |
|--------|----------|
| P0 | 制定整体架构方向，审核所有 PR（三人至少一人 approve，TL 对架构变更有一票否决权） |
| P0 | `server.js` 重构 — 当前 1800 行巨石，拆分为 `routes/` 模块化路由，每文件 ≤300 行 |
| P0 | 生命周期管理重写 — 关闭浏览器不应杀死服务，解耦 `gracefulShutdown()` |
| P1 | `lib/atomicJson.js` 修复 — `writeFile` 增加 `fsync` + 备份 + `withFileLock` 错误处理 |
| P1 | `lib/persistedSessions.js` 增强 — 会话快照/恢复，PTY 重启后精确 `--resume <id>` |
| P2 | 制定编码规范、分支策略、Release 流程 |
| P2 | 性能基准 — PTY 多路复用上限、内存增长曲线、事件循环延迟 |

### 产品管理 (30%)

| 优先级 | 工作内容 |
|--------|----------|
| P0 | 维护 Backlog，排定 Sprint 优先级 |
| P0 | 需求评审 — 确保不出现 "PM 定的需求技术不可行" |
| P1 | 每两周对外同步开发进度 |
| P1 | 对接开源社区 (bakapiano/ccsm upstream 沟通) |

---

## 核心技术要求

- **Node.js 深度**: Event Loop、Stream 背压、libuv 层行为
- **进程管理**: `node-pty`、`child_process`、Windows Job Objects、信号处理
- **文件系统**: NTFS/ext4 原子写入语义、fsync/fdatasync、Journal 机制——知道为什么 `rename` 是原子的但 `writeFile` 不是
- **WebSocket**: RFC 6455，帧级别 `ws` 库使用，Origin 校验
- **架构模式**: 中间件链、事件驱动、插件化

## 加分项

- 读过 `D:\AI IDE\CC_BOOS` 全部源码，理解 `server.js` ↔ `lib/` ↔ `public/js/` 的完整依赖链
- 了解 Claude Code 的 `--resume`、`--continue`、MCP 配置机制
- 有过重构 2000+ 行巨石 server 的经验

## 第一周目标

- [ ] 画出 BOOS 完整架构图 (ASCII 或 Excalidraw)
- [ ] 提交 `atomicJson.js` fsync 修复 PR
- [ ] 输出 `server.js` 拆分方案文档 (目标: 10 个路由文件, 每文件 ≤150 行)
- [ ] 建立 Backlog → Sprint → Review 节奏

## 你不需要

- 写前端 UI (除非紧急 bug)
- 手动测试 (QA 负责)
- 管服务器运维 (DevOps 后续补充)
