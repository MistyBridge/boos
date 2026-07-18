# HR Agent 资产库

> BOOS Agent 入职流水线的唯一数据源。PM 发起 recruitment 请求时，HR Agent 从此库匹配技能/MCP/行为模板。
> **架构完全对标** `D:\AI_Ex\skill\by-domain`。

---

## 📊 资产总览

| 类型 | 目录 | 数量 |
|------|------|------|
| **Skills 领域** | `skills/` | 18 个编号领域 |
| **Skill 目录** | `skills/<domain>/<name>/` | 69 个 |
| **Skill 文件 (SKILL.md)** | — | **1,854** |
| **Skill 总文件** | — | 14,926 |
| **MCP 服务器** | `mcps/` | 34 个 (12 分类) |
| **行为模板** | `templates/` | 7 种 |
| **SSE 循环** | `loops/` | 2 种 |
| **提示词片段** | `prompts/` | 7 个 |

---

## 📁 Skills 领域明细

| # | 领域 | 目录数 | SKILL.md | 文件数 |
|---|------|--------|----------|--------|
| 00 | 跨领域 | 1 | 2 | 3 |
| 01 | OS/内核 | 2 | 142 | 366 |
| 02 | 嵌入式 | 1 | 12 | 127 |
| 03 | 后端 | 15 | 201 | 2,792 |
| 04 | 存储/DB | 4 | 22 | 266 |
| 05 | 网络 | 3 | 112 | 885 |
| 06 | Web 前端 | 6 | 41 | 280 |
| 07 | 客户端/桌面 | 3 | 42 | 339 |
| 08 | 云/SRE | 2 | 44 | 201 |
| 09 | CI/CD 测试 | 1 | 43 | 337 |
| 10 | 大数据/AI/ML | 12 | 63 | 366 |
| 11 | LLM/Agent | 4 | 776 | 4,767 |
| 12 | 安全 | 1 | 75 | 996 |
| 13 | 编译器 | 1 | 10 | 12 |
| 14 | 量化 | 5 | 149 | 1,027 |
| 15 | 学术 | 1 | 1 | 2 |
| 16 | 任务调度 | 2 | 76 | 1,562 |
| 17 | 文档 | 5 | 33 | 499 |

---

## 🔑 重点仓库 (Top 5)

| 领域 | 仓库 | SKILL.md | 说明 |
|------|------|----------|------|
| 11-llm-agent | **claude-skills-collection** | 775 | Claude Skills 大集合 (⭐21K) — 最大单体 |
| 14-quant | **alpha-skills** | 145 | 量化交易 Alpha skills |
| 01-os-kernel | **low-level-dev-skills** | 142 | 底层开发全覆盖 |
| 12-security | **trailofbits-skills** | 75 | Trail of Bits 安全 skills |
| 03-backend | **jeffallan-skills** | 66 | Jeff Allan Claude skills |

---

## 📂 目录结构

```
HR/assets/
├── index.json                 ← 机器索引 (唯一入口)
├── README.md                  ← 本文件
├── EXTERNAL_SKILLS.md         ← 外部仓库来源目录
├── MCP_REFERENCE.md           ← MCP 参考文档
├── skills/                    ← 18 编号领域
├── mcps/                      ← 12 分类 · 34 MCPs
├── templates/                 ← 7 种行为模板
├── loops/                     ← SSE 循环 (2)
└── prompts/                   ← 人设/规范片段 (7)
```

---

## 🧹 清理记录

- 删除 48 个 `.git` 目录 (含历史，最大 `gstack/.git` 114MB)
- 删除 29 个 `.github` 目录
- 删除 7 个空壳目录 (`.git` 被删后仅剩自身)

---

*最后更新: 2026-07-17 · HR Agent · Sprint 18*
