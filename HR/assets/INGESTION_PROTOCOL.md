# Asset Ingestion Protocol (AIP)

> **版本**: 1.0-draft · 2026-07-18
> **适用范围**: `HR/assets/` 下全部五类资产入库操作
> **当前状态**: Skill 部分已完成，MCP/Template/Loop/Prompt 待补充

---

## 0. 总则

### 0.1 原子性

每次入库操作是一个原子事务。任一步骤失败 → 回滚到入库前状态。不存在"部分入库"。

### 0.2 单点真源 (Single Source of Truth)

| 数据 | 真源 |
|------|------|
| 全局仓库唯一性 | `.dedup.json` |
| L2 内仓库清单 | `<L2>/.manifest.json` |
| L1 汇总统计 | `<L1>/.manifest.json` |
| 结构定义 | `STRUCTURE.md` |

**规则**: 真源之间必须一致。不一致 = bug，立即修复。

### 0.3 不可修改原则 (Stage 1)

GitHub 采集的仓库内容**禁止任何修改**。不添加 SKILL.md、不删文件、不改名、不格式化。仓库即技能。

### 0.4 去重优先

一个仓库 = 一次克隆。其他 L2 需要同一仓库 → alias (manifest 引用，不重新克隆)。

---

## 1. Skill 入库协议

### 1.1 前置条件

入库前必须全部满足，否则拒绝：

| # | 条件 | 检查方式 |
|---|------|---------|
| P1 | 目标 L1 存在于 `STRUCTURE.md` | grep L1 ID |
| P2 | 目标 L2 存在于 `STRUCTURE.md` | grep L2 ID |
| P3 | L2 当前 `repo_count` < 14 | 读 L2 `.manifest.json` |
| P4 | 候选仓库 stars ≥ 1000 | GitHub API / 页面 |
| P5 | 仓库未 archived / deprecated | GitHub 页面 |
| P6 | 仓库与 L2 主题相关 | 人工判断 + description 匹配 |

### 1.2 发现 (Discovery)

```
输入: L2 ID + 主题关键词
输出: 候选仓库列表

步骤:
1. 在 GitHub 搜索 L2 主题关键词，按 stars 降序
2. 过滤: stars ≥ 1000, 非 archived, 非 fork (或 fork 显著优于原版)
3. 每 L2 最多保留 14 个候选 (含已存在)
4. 按 stars 从高到低排序
5. 对每个候选执行 §1.3 去重检查
```

### 1.3 去重检查 (Dedup Check) — 强制门禁

```
对每个候选仓库:

  node .dedup.js check <owner>/<repo>

  返回 exists: false
    → 进入 §1.4 采集流程

  返回 exists: true
    → 进入 §1.5 别名流程
```

**此步骤不可跳过。** 即使"记得"某仓库未入库，也必须执行 check。

### 1.4 采集流程 (Primary Ingest)

```
前置: .dedup.js check 返回 exists: false

步骤:
1. 构造镜像 URL:
   https://ghfast.top/https://github.com/<owner>/<repo>.git

2. 克隆到目标路径:
   cd <skills_root>/<L1>/<L2>/
   git clone --depth 1 <mirror_url> <owner-repo>

   超时: 120s
   失败处理: 重试 1 次，仍失败 → 跳过该仓库，记录到日志

3. 注册到去重表:
   node .dedup.js add <owner>/<repo> "<stars>" "<lang>" "<desc>" <L1>/<L2>

4. 验证克隆完整性:
   test -d <owner-repo>/.git
   test -f <owner-repo>/README.md  (或其他标志文件)

5. 写入 L2 manifest (§1.6)
6. 更新 L1 manifest (§1.7)
7. 写入操作日志 (§1.9)
```

### 1.5 别名流程 (Alias Ingest)

```
前置: .dedup.js check 返回 exists: true

步骤:
1. 注册别名:
   node .dedup.js alias <owner>/<repo> <L1>/<L2>

2. 在 L2 manifest 写入 ref 条目 (不克隆):

   "key": {
     "repo": "<owner>/<repo>",
     "ref": "<primary-L1>/<primary-L2>/<owner-repo>"
   }

3. 更新 L1 manifest (§1.7)
4. 写入操作日志 (§1.9)
```

### 1.6 L2 Manifest 写入规范

**路径**: `<L1>/<L2>/.manifest.json`

**Primary 条目格式** (完整):

```json
"<key>": {
  "repo": "<owner>/<repo>",
  "stars": "~<N>",
  "lang": "<Lang>",
  "description": "<单行描述>"
}
```

**Alias 条目格式** (引用):

```json
"<key>": {
  "repo": "<owner>/<repo>",
  "ref": "<L1>/<L2>/<owner-repo>"
}
```

> `key`: 默认取 repo name (如 `cobra`)。若与其他 key 冲突，追加 `-<owner>` 后缀 (如 `cli-urfave`)。

**写入步骤**:
1. 读取现有 `.manifest.json`
2. 在 `repos` 对象中添加新条目
3. 更新 `repo_count` = `Object.keys(repos).length`
4. 写入文件 (2-space indent, trailing newline)

### 1.7 L1 Manifest 更新规范

**路径**: `<L1>/.manifest.json`

**更新步骤**:
1. 读取现有 `.manifest.json`
2. 找到对应 subcategory，更新 `repo_count`
3. 更新 `total_repos` = `sum(subcategories[].repo_count)`
4. 写入文件

**一致性校验**:
```
total_repos === subcategories.reduce((sum, sc) => sum + sc.repo_count, 0)
total_repos === dedup 中 primary 在此 L1 下的仓库数
```

### 1.8 回滚协议

任一步骤失败时，按逆序回滚：

| 失败步骤 | 回滚操作 |
|---------|---------|
| git clone 失败 | 删除半成品目录 (如有) |
| .dedup.js add 失败 | 删除已克隆目录 |
| L2 manifest 写入失败 | 删除克隆目录 + .dedup.json 回滚 |
| L1 manifest 写入失败 | 重试 3 次，仍失败则人工介入 |

**回滚命令**:
```bash
# 删除克隆
rm -rf <skills_root>/<L1>/<L2>/<owner-repo>

# 从去重表移除 (手动编辑 .dedup.json)
# 删除 repos["<owner>/<repo>"] 条目
# stats.total_unique--, stats.total_refs--
```

### 1.9 操作日志

每次入库操作追加一行到 `<skills_root>/.ingestion.log.jsonl`:

```jsonl
{"ts":"2026-07-18T10:30:00Z","action":"ingest","type":"primary","repo":"owner/repo","stars":"~12,000","lang":"Go","target":"01-os-kernel/02-build","status":"ok"}
{"ts":"2026-07-18T10:31:00Z","action":"alias","repo":"owner/repo","target":"06-backend/06-devtool","status":"ok"}
{"ts":"2026-07-18T10:32:00Z","action":"ingest","type":"primary","repo":"bad/repo","target":"01-os-kernel/02-build","status":"fail","error":"clone timeout"}
```

### 1.10 批量入库批次

一次批量入库（同一 L2 连续采集多个仓库）记录一条批次日志到 `<skills_root>/.batch.log.jsonl`:

```jsonl
{"ts":"2026-07-18T11:00:00Z","batch_id":"b-001","l2":"01-os-kernel/02-build","actions":{"total":8,"ingested":6,"aliased":1,"skipped":1,"failed":0},"duration_ms":245000}
```

---

## 2. 入库后验证 (Post-Ingestion Audit)

每次入库完成后执行：

```
□ .dedup.json repos 条目存在
□ 克隆目录存在且含 .git/
□ L2 .manifest.json repos 包含该条目
□ L2 .manifest.json repo_count == Object.keys(repos).length
□ L1 .manifest.json subcategory.repo_count 匹配
□ L1 .manifest.json total_repos == sum(subcategories[].repo_count)
□ L1 .manifest.json total_repos == dedup stats 中该 L1 的条目数
```

---

## 3. 待补充

| 资产类型 | 目录 | 差异点 | 状态 |
|---------|------|-------|------|
| MCP | `HR/assets/mcps/` | 无 GitHub 采集，纯原创；需校验 MCP 配置有效性 | 待编写 |
| Template | `HR/assets/templates/` | 行为模板，纯原创；需校验模板完整性 | 待编写 |
| Loop | `HR/assets/loops/` | SSE 循环配置，纯原创 | 待编写 |
| Prompt | `HR/assets/prompts/` | 人设/JD 片段，纯原创 | 待编写 |

---

## 附录 A: 命令速查

```bash
# 去重检查
node .dedup.js check spf13/cobra

# 注册新仓库 (clone 成功后)
node .dedup.js add spf13/cobra "~39,000" "Go" "CLI framework" 17-cross-domain/09-cli

# 注册别名
node .dedup.js alias spf13/cobra 06-backend/06-devtool

# 查看统计
node .dedup.js stats

# 查找仓库位置
node .dedup.js where clap-rs/clap

# 列出全部仓库 (按 stars 排序)
node .dedup.js list
```

## 附录 B: L2 Manifest 完整示例

```json
{
  "category": "09-cli",
  "domain": "17-cross-domain",
  "label": "CLI Design Engineering",
  "repo_count": 12,
  "source": "github",
  "min_stars": 8000,
  "repos": {
    "cobra": {
      "repo": "spf13/cobra",
      "stars": "~39,000",
      "lang": "Go",
      "description": "A Commander for modern Go CLI interactions"
    },
    "fd": {
      "repo": "sharkdp/fd",
      "ref": "17-cross-domain/09-cli/sharkdp-fd"
    }
  }
}
```

## 附录 C: L1 Manifest 完整示例

```json
{
  "domain": "17-cross-domain",
  "label": "跨领域通用",
  "source": "github",
  "total_repos": 12,
  "subcategory_count": 13,
  "subcategories": [
    {
      "category": "09-cli",
      "label": "CLI 设计",
      "repo_count": 12,
      "source": "github",
      "min_stars": 8000
    },
    {
      "category": "01-design",
      "label": "软件设计",
      "repo_count": 0,
      "source": "github"
    }
  ]
}
```
