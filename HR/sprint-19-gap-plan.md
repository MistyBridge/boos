# Sprint 19 · 技能库缺口填补计划

> 2026-07-18 · L1×L2 缺口侦查 + 量化基金业务对标

---

## 资产质量门禁

| 规则 | 标准 |
|---|---|
| 外部源入库 | GitHub ≥100⭐，低于此标准拒收 |
| 平台原创 | PM 审核每篇 SKILL.md |
| 高星源入库流程 | 搜索 → 验证星数 → 筛选 → 按 ≤10 字符重命名 → 创建目录与 manifest |
| 无合适开源源 | 原创撰写，标注"原创" |

---

## Phase 0 · 人机共用平台基础设施

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 00-cross-domain | 13-cli | CLI 设计工程 (CLI Design Engineering) | 8–12 |
| 00-cross-domain | 14-mcp | MCP 服务设计 (MCP Service Design) | 8–12 |
| 00-cross-domain | 15-hmint | 人机共用接口 (Human-Machine Interface) | 8–12 |
| 00-cross-domain | 16-platfm | 平台工程 (Platform Engineering) | 8–12 |
| 11-llm-agent | 15-tooleng | Tool 工程化 (Tool Engineering) | 6–8 |
| 17-documentation | 12-platdoc | 平台文档 (Platform Documentation) | 4–6 |

---

## Phase 1 · CRITICAL 缺口

### 后端与存储

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 03-backend | 04-async | 异步与消息队列 (Async & MQ) | 8–12 |
| 03-backend | 07-auth | 认证与授权 (Auth & AuthZ) | 8–12 |
| 04-storage-db | 05-migr | Schema 迁移与版本控制 (Schema Migration) | 6–8 |
| 04-storage-db | 06-idx | 索引与查询调优 (Indexing & Tuning) | 6–8 |

### 网络与基础设施

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 05-networking | 07-gw | API 网关 (API Gateway) | 6–8 |
| 08-cloud-sre | 09-cost | FinOps 成本管理 (Cloud Cost Management) | 8–12 |
| 01-os-kernel | 14-fs | 文件系统 (File Systems) | 8–12 |

### 安全与数据治理

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 12-security | 13-threatmd | 威胁建模 (Threat Modeling) | 8–12 |
| 10-bigdata | 06-datagov | 数据治理 (Data Governance) | 8–12 |
| 09-cicd-testing | 04-unit | 单元与集成测试 (Unit/Integration Test) | 12–18 |

### 前端与客户端

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 06-web-frontend | 08-state | 状态管理 (State Management) | 8–12 |
| 07-client-desktop | 05-desktop | 桌面应用开发 (Desktop Development) | 12–18 |

### Agent 生态

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 11-llm-agent | 08-agcom | Agent 通信协议 (Agent Communication) | 8–12 |

### 嵌入式与交叉域

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 02-embedded | 07-wire | 无线通信 (Wireless Communication) | 10–15 |
| 00-cross-domain | 06-perf | 性能工程 (Performance Engineering) | 6–8 |
| 14-quant | 02-alpha | 因子与 Alpha 研究 (Alpha Research) | 8–12 |

---

## Phase 2 · 金融专属 L1 新建

### 2.1 行情数据基础设施 (20-mkt-data)

| L2 | 名称 | 预计 skill 数 |
|---|---|---|
| 01-l2order | 订单簿重建与合成 | 6–8 |
| 02-bar | 多频数据维护 | 4–6 |
| 03-vendor | 数据商适配 | 6–8 |
| 04-rproc | 券商反采 | 4–6 |
| 05-sim | 仿真行情生成 | 4–6 |
| 06-qual | 数据质量与校验 | 4–6 |

### 2.2 交易执行系统 (21-tradex)

| L2 | 名称 | 预计 skill 数 |
|---|---|---|
| 01-algos | 智能算法引擎 | 6–8 |
| 02-broker | 券商柜台对接 | 6–8 |
| 03-riskctl | 独立风控系统 | 6–8 |
| 04-simch | 模拟交易通道 | 4–6 |
| 05-admin | 管理后台 | 4–6 |
| 06-omsems | OMS/EMS 状态机 | 6–8 |
| 07-latopt | 低延迟策略引擎优化 | 6–8 |
| 08-tradtool | 大交易员辅助系统 | 4–6 |

### 2.3 因子计算平台 (22-factor)

| L2 | 名称 | 预计 skill 数 |
|---|---|---|
| 01-taxon | 因子分类体系 | 4–6 |
| 02-store | 离线因子存储 | 4–6 |
| 03-serve | 在线因子服务 | 4–6 |
| 04-dist | 分布式因子计算 | 6–8 |
| 05-mon | 因子质量监控 | 4–6 |
| 06-feateng | 特征工程管道 | 6–8 |

### 2.4 回测与仿真 (23-backtest)

| L2 | 名称 | 预计 skill 数 |
|---|---|---|
| 01-evt-drv | 事件驱动回测引擎 | 6–8 |
| 02-tca | 交易成本模型 | 4–6 |
| 03-params | 参数扫描与并行 | 4–6 |
| 04-wfa | Walk-Forward 分析 | 4–6 |
| 05-simloop | 仿真全链路闭环 | 4–6 |

### 2.5 金融产品工程 (24-fin-prod)

| L2 | 名称 | 预计 skill 数 |
|---|---|---|
| 01-deriv | 衍生品定价 | 6–8 |
| 02-fixedinc | 固收分析 | 4–6 |
| 03-struct | 结构化产品 | 4–6 |
| 04-cptyrisk | 对手方风险 | 4–6 |
| 05-volsurf | 波动率曲面 | 4–6 |

### 2.6 交易后处理 (25-post-trade)

| L2 | 名称 | 预计 skill 数 |
|---|---|---|
| 01-recon | 交易对账 | 4–6 |
| 02-settle | 清算交收 | 4–6 |
| 03-pnlattr | 损益归因 | 4–6 |
| 04-corpact | 公司事件处理 | 4–6 |

### 2.7 基金运营 (26-fundops)

| L2 | 名称 | 预计 skill 数 |
|---|---|---|
| 01-nav | 净值核算与基金会计 | 4–6 |
| 02-subsc | 申赎处理 | 4–6 |
| 03-ta | TA 登记与过户 | 4–6 |
| 04-cash | 资金管理 | 4–6 |
| 05-report | 投资者报告 | 4–6 |
| 06-reg | 监管报送 | 6–8 |
| 07-prodset | 产品设立 | 4–6 |

### 2.8 量化研究扩展 (14-quant 追加)

| L2 | 名称 | 预计 skill 数 |
|---|---|---|
| 17-sigeval | 信号绩效评估系统 | 6–8 |
| 18-autores | 自主研究工具平台 | 6–8 |
| 19-portopt | 投资组合优化 | 6–8 |

---

## Phase 3 · HIGH 缺口

### 后端与存储

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 03-backend | 14-cfg | 配置与密钥管理 (Config & Secrets) | 6–8 |
| 03-backend | 15-rate | 限流与防护 (Rate Limiting) | 4–6 |
| 04-storage-db | 07-ha | 高可用与复制 (HA & Replication) | 6–8 |
| 04-storage-db | 08-ts | 时序数据库 (Time-Series DB) | 6–8 |

### 网络与云

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 05-networking | 08-cdn | CDN 与边缘网络 (CDN & Edge) | 6–8 |
| 05-networking | 09-svcmsh | 服务网格 (Service Mesh) | 6–8 |
| 08-cloud-sre | 10-net | 云网络 (Cloud Networking) | 8–12 |
| 08-cloud-sre | 11-srvless | 无服务器计算 (Serverless) | 7–10 |
| 01-os-kernel | 14-net | 内核网络栈 (Kernel Networking) | 8–12 |
| 01-os-kernel | 14-cont | 容器底层 (Container Primitives) | 6–8 |

### 安全与数据

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 12-security | 14-cloudsec | 云安全 (Cloud Security) | 6–8 |
| 12-security | 15-apisec | API 安全 (API Security) | 6–8 |
| 10-bigdata | 07-datarch | 数据架构 (Data Architecture) | 6–8 |
| 10-bigdata | 08-stream | 流计算引擎 (Stream Processing) | 6–8 |
| 09-cicd-testing | 13-ctrtest | 契约与变异测试 (Contract & Mutation) | 4–6 |

### 前端与客户端

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 06-web-frontend | 09-pwa | PWA 与离线优先 (PWA & Offline) | 6–9 |
| 06-web-frontend | 10-ssr | 渲染策略 (SSR & Rendering) | 6–9 |
| 07-client-desktop | 06-dart-fl | Flutter 深度 (Flutter Deep) | 7–10 |

### 嵌入式

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 02-embedded | 08-power | 功耗管理 (Power Management) | 6–8 |
| 02-embedded | 09-test | 嵌入式测试 (Embedded Testing) | 6–8 |

### 交叉域与 Agent

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 00-cross-domain | 06-api | API 设计 (API Design) | 6–8 |
| 00-cross-domain | 06-obsrv | 可观测性 (Observability) | 6–8 |
| 11-llm-agent | 13-agsec | Agent 安全 (Agent Security) | 6–8 |
| 15-academic | 04-write | 学术写作 (Academic Writing) | 4–6 |

### 编译器与小众领域

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 13-compiler | 05-parse | 编译器前端与解析 (Frontend & Parsing) | 4–6 |
| 13-compiler | 06-type | 类型系统 (Type Systems) | 4–6 |
| 13-compiler | 07-runtime | 运行时系统 (Runtime Systems) | 4–6 |
| 16-task-scheduling | 03-track | 进度追踪 (Progress Tracking) | 4–6 |
| 16-task-scheduling | 04-dep | 依赖管理 (Dependency Management) | 4–6 |

### 文档与学术

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 17-documentation | 03-spec | 技术规格 (Technical Specs) | 4–6 |
| 15-academic | 05-meth | 研究方法论 (Research Methodology) | 4–6 |

---

## Phase 4 · MEDIUM 缺口

| L1 | L2 | 名称 | 预计 skill 数 |
|---|---|---|---|
| 00-cross-domain | 06-data | 数据建模 (Data Modeling) | 4–6 |
| 00-cross-domain | 06-migr | 系统迁移 (System Migration) | 4–6 |
| 01-os-kernel | 14-mem | 内存管理 (Memory Management) | 4–6 |
| 01-os-kernel | 14-rt | 实时 Linux (Real-Time Linux) | 4–6 |
| 02-embedded | 10-sense | 传感器与执行 (Sensors & Actuation) | 4–6 |
| 02-embedded | 11-auto | 汽车电子 (Automotive) | 4–6 |
| 02-embedded | 12-iot | IoT 协议栈 (IoT Stack) | 4–6 |
| 02-embedded | 07-dsp | 嵌入式 DSP (Embedded DSP) | 4–6 |
| 03-backend | 16-email | 邮件与通知 (Email & Notify) | 4–6 |
| 03-backend | 17-file | 文件处理 (File Handling) | 4–6 |
| 04-storage-db | 09-graph | 图数据库 (Graph DBs) | 4–6 |
| 04-storage-db | 10-vector | 向量数据库 (Vector DBs) | 4–6 |
| 05-networking | 10-natfw | NAT 与防火墙 (NAT & Firewall) | 4–6 |
| 05-networking | 11-iot | IoT 协议 (IoT Protocols) | 4–6 |
| 06-web-frontend | 11-i18n | 国际化 (i18n) | 5–7 |
| 06-web-frontend | 12-route | 路由 (Routing) | 5–7 |
| 06-web-frontend | 13-form | 表单与校验 (Forms) | 5–8 |
| 06-web-frontend | 14-webapi | 浏览器 Web API | 5–8 |
| 07-client-desktop | 07-rn-deep | RN 深度 (RN Deep) | 6–9 |
| 07-client-desktop | 08-qt | Qt 框架 (Qt Framework) | 6–9 |
| 08-cloud-sre | 12-mesh | 服务网格 (Service Mesh) | 6–8 |
| 08-cloud-sre | 13-iam | 云 IAM (Cloud IAM) | 6–9 |
| 10-bigdata | 09-vectordb | 向量数据库 (Vector DBs) | 4–6 |
| 11-llm-agent | 14-llmserv | LLM 推理部署 (LLM Serving) | 6–8 |
| 12-security | 16-privacy | 隐私工程 (Privacy Engineering) | 4–6 |
| 09-cicd-testing | 14-featflg | 特性开关 (Feature Flags) | 4–6 |
| 15-academic | 06-peer | 同行评审 (Peer Review) | 4–6 |
| 15-academic | 07-repro | 可复现性 (Reproducibility) | 4–6 |
| 15-academic | 08-mlsci | 科学 ML (ML4Science) | 4–6 |
| 16-task-scheduling | 05-notif | 通知告警 (Notification) | 4–6 |
| 16-task-scheduling | 06-event | 事件驱动触发 (Event Triggers) | 4–6 |

---

## 总览

| Phase | 内容 | L2 数 | 预计 skill 数 |
|---|---|---|---|
| 0 | 人机共用平台基础设施 | 6 | ~50 |
| 1 | CRITICAL 缺口 | 16 | ~170 |
| 2 | 金融专属 L1 新建 | 44 | ~244 |
| 3 | HIGH 缺口 | 31 | ~210 |
| 4 | MEDIUM 缺口 | 31 | ~140 |
| **总计** | | **128** | **~814** |
