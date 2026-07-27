# OpenViking 使用指南

> 本地部署 · 多用户协作 · AI 记忆系统
>
> 服务器: `192.168.2.200:1933` | 版本: `v0.4.10` | Web Studio: `http://192.168.2.200:1933/studio`

---

## 目录

1. [架构概览](#1-架构概览)
2. [管理员操作](#2-管理员操作)
3. [同事注册与使用](#3-同事注册与使用)
4. [Claude Code 插件配置](#4-claude-code-插件配置)
5. [API 速查](#5-api-速查)
6. [故障排查](#6-故障排查)

---

## 1. 架构概览

```
┌──────────────────────────────────────────────┐
│              192.168.2.200 (Linux)            │
│                                               │
│  OpenViking Server :1933                      │
│  ├─ Web Studio     /studio                    │
│  ├─ REST API       /api/v1/*                  │
│  ├─ Embedding      bge-small-zh-v1.5 (GGUF)   │
│  └─ VikingBot      :18790 (内部网关)           │
│                                               │
│  LLM API: packyapi (deepseek-pro)             │
└──────────────────────────────────────────────┘
         │
         │ 内网 HTTP
         ▼
┌──────────────────────┐    ┌──────────────────────┐
│  你的 Windows 电脑    │    │  同事的电脑            │
│  ovcli.conf → :1933  │    │  ovcli.conf → :1933  │
│  CC Plugin 自动读写   │    │  CC Plugin 自动读写   │
└──────────────────────┘    └──────────────────────┘
```

**认证模型**: `api_key` — 每个用户有独立 API Key，Root Key 仅管理员使用。

**Key 层级**:
| Key 类型 | 用途 | 能做什么 |
|----------|------|---------|
| `root_api_key` | 服务器管理 | 创建账号、管理用户、生成 User Key |
| User API Key | 日常使用 | 读/写记忆、语义搜索 |

---

## 2. 管理员操作

> ⚠️ Root Key 只在 Linux 服务器上操作，不要发给任何人。

### 2.1 获取 Root Key

Root Key 定义在服务器配置文件中：

```bash
# SSH 到 Linux 服务器
ssh kehan@192.168.2.200

# 查看 Root Key
cat ~/.openviking/ov.conf | grep root_api_key
```

当前 Root Key: 见 `~/.openviking/ov.conf` 中 `server.root_api_key` 字段。

### 2.2 服务器管理

```bash
# 查看状态
curl http://localhost:1933/health

# 重启服务
fuser -k 1933/tcp 18790/tcp
nohup bash ~/start-ov-bot.sh > /tmp/ov-bot.log 2>&1 &

# 查看日志
tail -f /tmp/ov-bot.log
```

### 2.3 创建新账号（Account）

每个同事或项目组创建一个 Account：

```bash
ROOT_KEY="你的root_key"
ACCOUNT_NAME="项目名或团队名"   # 如 "quant-team", "frontend-team"

curl -s -X POST http://localhost:1933/api/v1/admin/accounts \
  -H "x-api-key: $ROOT_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"account_id\": \"$ACCOUNT_NAME\"}"
```

```json
// 返回示例
{"status":"ok","result":{"account_id":"quant-team","created_at":"..."}}
```

> **命名建议**: Account 用团队名（如 `boos-team`），一个团队共用一个 Account。

### 2.4 为同事创建用户（User）并获取 User Key

在 Account 下创建用户，返回的 `api_key` 就是同事的 User Key：

```bash
ROOT_KEY="你的root_key"
ACCOUNT="boos-team"      # 账号名
USER_NAME="zhangsan"      # 同事用户名（英文）

curl -s -X POST "http://localhost:1933/api/v1/admin/accounts/$ACCOUNT/users" \
  -H "x-api-key: $ROOT_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\": \"$USER_NAME\", \"role\": \"admin\"}"
```

```json
// 返回示例 — api_key 就是同事的 User Key
{
  "status": "ok",
  "result": {
    "user_id": "zhangsan",
    "role": "admin",
    "api_key": "Ym9vcy10ZWFtLnpoYW5nc2FuLmFiYzEyMzRlZm...",
    "created_at": "2026-07-20T..."
  }
}
```

> **role 说明**:
> - `admin` — 可以读/写记忆，管理同 Account 下的资源（推荐给同事）
> - `user` — 只能读/写自己的记忆

### 2.5 查看所有账号和用户

```bash
ROOT_KEY="你的root_key"

# 列出所有账号
curl -s -H "x-api-key: $ROOT_KEY" http://localhost:1933/api/v1/admin/accounts

# 列出某账号下的用户
curl -s -H "x-api-key: $ROOT_KEY" \
  "http://localhost:1933/api/v1/admin/accounts/boos-team/users"
```

### 2.6 为用户重置/获取 API Key

```bash
ROOT_KEY="你的root_key"
ACCOUNT="boos-team"
USER_NAME="zhangsan"

# 获取用户当前 API Key
curl -s -H "x-api-key: $ROOT_KEY" \
  "http://localhost:1933/api/v1/admin/accounts/$ACCOUNT/users/$USER_NAME/key"
```

### 2.7 删除用户

```bash
ROOT_KEY="你的root_key"
ACCOUNT="boos-team"
USER_NAME="zhangsan"

curl -s -X DELETE \
  -H "x-api-key: $ROOT_KEY" \
  "http://localhost:1933/api/v1/admin/accounts/$ACCOUNT/users/$USER_NAME"
```

---

## 3. 同事注册与使用

### 3.1 同事需要的文件

同事只需在 Windows 上创建 **一个配置文件**：

```powershell
# 创建目录
mkdir -p $env:USERPROFILE\.openviking

# 创建配置文件（替换 YOUR_API_KEY 为管理员给你的 key）
@"
{
  "url": "http://192.168.2.200:1933",
  "api_key": "YOUR_API_KEY"
}
"@ | Out-File -Encoding utf8 $env:USERPROFILE\.openviking\ovcli.conf
```

### 3.2 验证连接

```bash
# 替换为同事的 API Key
API_KEY="你的api_key"

# 测试连接
curl -s -H "x-api-key: $API_KEY" http://192.168.2.200:1933/api/v1/debug/vector/count

# 如果返回 {"status":"ok","result":{"count":27}} 则连接成功
```

### 3.3 安装 Claude Code 插件

```bash
# 安装 OpenViking Memory 插件
claude plugins install openviking-memory
```

安装后 CC 会自动读取 `~/.openviking/ovcli.conf`，每次对话的记忆会自动存入 OpenViking。

### 3.4 给同事的完整配置清单

给同事发这个清单：

```
你的 OpenViking 配置：

1. 创建文件 C:\Users\<你的用户名>\.openviking\ovcli.conf
   内容：
   {
     "url": "http://192.168.2.200:1933",
     "api_key": "<管理员给你的 API Key>"
   }

2. 安装 CC 插件：
   claude plugins install openviking-memory

3. 验证：
   打开 CC，跟 AI 对话几轮，记忆会自动存储。
   访问 http://192.168.2.200:1933/studio 查看 Web Studio。
```

---

## 4. Claude Code 插件配置

### 4.1 当前配置（你的环境）

**文件**: `C:\Users\admin\.openviking\ovcli.conf`
```json
{
  "url": "http://192.168.2.200:1933",
  "api_key": "Ym9vcy10ZWFtLmFkbWluLmYzMTlkZmRj..."
}
```

**文件**: `D:\AI IDE\CC_BOOS\.claude\settings.local.json` （额外环境变量）
```json
{
  "env": {
    "OPENVIKING_BASE_URL": "http://192.168.2.200:1933"
  }
}
```

### 4.2 API Key 优先级

CC 插件按以下顺序查找 API Key（找到即停）：

1. 环境变量 `OPENVIKING_API_KEY`
2. 环境变量 `OPENVIKING_BEARER_TOKEN`
3. `~/.openviking/ovcli.conf` 中的 `api_key`
4. CC settings 中的 `claude_code.apiKey`
5. 服务器 `root_api_key`（不推荐）

推荐方式：只用 `ovcli.conf`，简洁且不污染环境变量。

---

## 5. API 速查

### 5.1 健康检查

```bash
# 无需认证
curl http://192.168.2.200:1933/health
# → {"status":"ok","healthy":true,"version":"0.4.10"}
```

### 5.2 管理员 API（需要 Root Key）

```bash
ROOT_KEY="ov-root-..."

# 账号管理
GET    /api/v1/admin/accounts                          # 列出所有账号
POST   /api/v1/admin/accounts                          # 创建账号
GET    /api/v1/admin/accounts/{id}                      # 账号详情
DELETE /api/v1/admin/accounts/{id}                      # 删除账号

# 用户管理
GET    /api/v1/admin/accounts/{id}/users                # 列出用户
POST   /api/v1/admin/accounts/{id}/users                # 创建用户
DELETE /api/v1/admin/accounts/{id}/users/{uid}          # 删除用户
GET    /api/v1/admin/accounts/{id}/users/{uid}/key      # 获取用户 Key
```

### 5.3 用户 API（需要 User Key）

```bash
API_KEY="你的user_key"

# 写入记忆
POST /api/v1/content/write
Body: {"uri":"viking://user/admin/memories/xxx.md","content":"...","mode":"create","wait":true}

# 读取记忆
GET  /api/v1/content/read?uri=viking://user/admin/memories/xxx.md

# 语义搜索
POST /api/v1/code/search
Body: {"uri":"viking://user/admin/memories","query":"搜索内容","limit":5}

# 文件浏览
GET  /api/v1/fs/ls?uri=viking://user/admin

# 向量统计
GET  /api/v1/debug/vector/count
```

### 5.4 URI 格式

```
viking://user/<用户名>/<目录>/<文件名>

  可用目录:
  ├─ memories/    ← AI 对话记忆（最常用）
  ├─ resources/   ← 私有文档/知识库
  ├─ sessions/    ← 会话记录
  ├─ skills/      ← Claude Skills 定义
  └─ peers/       ← 协作伙伴记忆
```

---

## 6. 故障排查

### 服务器无响应

```bash
# 检查服务器是否在运行
curl http://192.168.2.200:1933/health

# 如果无响应，SSH 到 Linux 查看状态
ssh kehan@192.168.2.200
ps aux | grep openviking
tail -20 /tmp/ov-bot.log
```

### 重启服务

```bash
ssh kehan@192.168.2.200
fuser -k 1933/tcp 18790/tcp
nohup bash ~/start-ov-bot.sh > /tmp/ov-bot.log 2>&1 &
```

### API Key 无效

```bash
# 在 Linux 上用 Root Key 查看用户 Key
ROOT_KEY="ov-root-..."
curl -s -H "x-api-key: $ROOT_KEY" \
  "http://localhost:1933/api/v1/admin/accounts/boos-team/users" | python3 -m json.tool
```

### 防火墙/连接问题

- 确认同事电脑与 Linux 服务器在同一内网（192.168.2.x）
- Windows 防火墙通常不阻止出站连接，无需额外配置
- 如果 VPN 环境，确保 1933 端口可达

### Embedding 模型问题

```bash
# 查看向量数量（>0 表示 embedding 工作正常）
curl -s -H "x-api-key: $API_KEY" http://192.168.2.200:1933/api/v1/debug/vector/count

# 模型文件位置（Linux 上）
ls -la ~/.cache/openviking/models/bge-small-zh-v1.5-f16.gguf
# 约 46MB
```
