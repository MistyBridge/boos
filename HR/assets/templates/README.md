# Agent 通用模板基底

> 7 种基础行为模板，按 Agent 核心工作模式划分。与 `roles/`（按业务职能划分）互补——角色决定「懂什么」，模板决定「怎么干」。

## 模板总览

| # | 模板 | 权限 | 核心职责 | 输入 ← | → 输出 |
|---|------|------|---------|--------|--------|
| 1 | **Analyzer** | Read | 解析存量代码、梳理架构依赖 | 代码库路径 | 架构分析报告 |
| 2 | **Researcher** | Read+Web | 调研技术方案、行业实践 | 调研主题 | 调研简报 |
| 3 | **Planner** | Read | 消化需求→拆解→出工程方案 | Analyzer+Researcher+PRD | 工程实施方案 |
| 4 | **Builder** | Read+Write | 从零开发新功能、写测试 | Planner方案(经Orchestrator) | 新代码+测试 |
| 5 | **Fixer** | Read+Write | 诊断根因、修复Bug | Bug报告/Reviewer整改清单 | 修复代码+根因分析 |
| 6 | **Reviewer** | Read | 扫描安全/性能/规范/逻辑 | 代码diff/PR | 整改清单 |
| 7 | **Orchestrator** | Full | 分发任务、收集结果、校验交付 | Planner方案 | 最终交付物+执行报告 |

## 协作流程

```
需求 / PRD
    │
    ▼
┌──────────────────────────────────────┐
│  Analyzer ──→ 架构分析报告            │
│  Researcher ──→ 技术调研简报           │
│       ╲         ╱                    │
│        ▼       ▼                     │
│      Planner ──→ 工程实施方案          │
│                    │                 │
│                    ▼                 │
│     Orchestrator ──→ 任务分发          │
│         │         │        │         │
│         ▼         ▼        ▼         │
│     Builder    Fixer   Reviewer      │
│         │         │        │         │
│         └────┬────┴────────┘         │
│              ▼                       │
│     Orchestrator ──→ 汇总/校验/交付    │
└──────────────────────────────────────┘
```

## 权限矩阵

> **全局强制规则：** 所有模板必装 `agent-bus` MCP；所有写代码的模板（Builder/Fixer）必装 `ponytail` Skill。

| 模板 | Read | Web | Agent-Bus | Write(代码) | Exec | Dispatch | Ponytail |
|------|:---:|:---:|:---------:|:-----------:|:----:|:--------:|:--------:|
| Analyzer | ✅ | ✅ | ● | ❌ | ❌ | ❌ | — |
| Researcher | ✅ | ✅ | ● | ❌ | ❌ | ❌ | — |
| Planner | ✅ | ✅ | ● | ❌ | ❌ | ❌ | — |
| Builder | ✅ | ✅ | ● | ✅ | ✅ | ❌ | ● |
| Fixer | ✅ | ✅ | ● | ✅ | ✅ | ❌ | ● |
| Reviewer | ✅ | ✅ | ● | ❌ | ❌ | ❌ | — |
| Orchestrator | ✅ | ✅ | ● | ✅ | ✅ | ✅ | ○ |

● 必装 &nbsp; ○ 推荐 &nbsp; — 不需要

## 使用方式

### 新建 Agent 时
1. 选择业务角色（`roles/`）→ 确定技能栈
2. 选择行为模板（`templates/`）→ 确定工作模式和权限
3. 组合后通过 `scripts/onboard.ps1` 写入 `.claude/` 配置

### 模板文件说明
每个模板目录包含：
- `template.json` — 结构化配置（与 role JSON 兼容的格式）
- `system.md` — 系统提示词（可直接作为 agent 的 CLAUDE.md 或 system prompt）
