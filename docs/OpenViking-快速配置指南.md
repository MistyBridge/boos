# OpenViking 快速配置指南

> 自建 AI 知识库 — 3 分钟完成配置，所有 AI 工具共享同一份长期记忆。

---

## 0. 准备清单

开始前，确保你已从管理员处获得：

| 准备项 | 示例 | 说明 |
|--------|------|------|
| **服务器地址** | `http://192.168.2.200:1933` | 内网 OpenViking 地址 |
| **User API Key** | `boos-team.zhangsan.abc123...` | 管理员创建账号后提供 |

> ⚠️ 没有 User API Key？联系管理员获取。

---

## 1. 创建配置文件（所有人通用）

在 **用户目录** 下创建 `~/.openviking/ovcli.conf`，所有工具都会自动读取它。

### Windows（PowerShell）

```powershell
mkdir -p $env:USERPROFILE\.openviking

@"
{
  "url": "http://192.168.2.200:1933",
  "api_key": "YOUR_API_KEY"
}
"@ | Out-File -Encoding utf8 $env:USERPROFILE\.openviking\ovcli.conf
```

### Linux / macOS

```bash
mkdir -p ~/.openviking

cat > ~/.openviking/ovcli.conf << 'EOF'
{
  "url": "http://192.168.2.200:1933",
  "api_key": "YOUR_API_KEY"
}
EOF
```

---

## 2. 按你的工具选择配置方式

---

### A. Claude Code CLI

```bash
# 1. 添加 OpenViking 官方 marketplace
claude plugin marketplace add https://raw.githubusercontent.com/volcengine/OpenViking/main/.claude-plugin/marketplace.json

# 2. 安装记忆插件
claude plugin install openviking-memory@openviking
```

> 国内网络慢可换镜像：把 URL 中 `raw.githubusercontent.com` 替换为 `ghfast.top/https://raw.githubusercontent.com`

**插件做了什么？**

- **自动召回**：每次你发消息前，自动从 OpenViking 搜索相关历史记忆注入上下文
- **自动捕获**：每次对话结束，自动提取关键信息写入 OpenViking
- **MCP 工具**：提供 `write_memory`、`read_memory`、`search_memory` 等工具，AI 可主动调用

---

### B. VS Code Claude Code 插件

与 CLI 完全相同。在 VS Code 终端中执行 A 的两条命令即可。VS Code 版 Claude Code 共享同一套 `~/.claude/plugins/` 目录。

---

### C. OpenClaw

OpenViking 原生支持 MCP 协议，端点地址为 `{服务器地址}/mcp`。

#### 方式一：MCP 适配器（推荐）

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "plugins": {
    "entries": {
      "mcp-adapter": {
        "enabled": true,
        "config": {
          "servers": [
            {
              "name": "openviking",
              "transport": "http",
              "url": "http://192.168.2.200:1933/mcp",
              "headers": {
                "Authorization": "Bearer YOUR_API_KEY"
              }
            }
          ]
        }
      }
    }
  }
}
```

然后：

```bash
openclaw plugins install mcp-adapter
openclaw gateway restart
```

#### 方式二：一行安装脚本

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/volcengine/OpenViking/main/examples/memory-plugin-shared/install.sh) --harness openclaw
```

> 更多 OpenClaw 配置细节见 [OpenViking 完整指南](OpenViking-使用指南.md)。

---

## 3. 验证

```bash
curl -s -H "x-api-key: 你的API_KEY" http://192.168.2.200:1933/api/v1/debug/vector/count
```

返回 `{"status":"ok","result":{"count":...}}` → 配置成功。

---

## 4. 完成

从现在开始，你的 AI 对话会自动：

- ✅ **写入记忆** — 重要信息自动存入 OpenViking
- ✅ **语义召回** — 下次对话自动检索相关历史
- ✅ **Web Studio** — 访问 `http://192.168.2.200:1933/studio` 浏览所有记忆
- ✅ **跨工具共享** — Claude Code 写的记忆，OpenClaw 也能召回

---

## 快速对照

| 工具 | 配置方式 | 原理 |
|------|----------|------|
| Claude Code CLI | marketplace + plugin | Hooks 自动捕获/召回 + MCP proxy 提供工具 |
| VS Code Claude Code | 同上 | 与 CLI 共享 `~/.claude/plugins/` |
| OpenClaw | MCP 适配器 | 直连 OpenViking 原生 `/mcp` 端点 |

---

## 故障排查

| 问题 | 检查 |
|------|------|
| 配置不生效 | 确认 `ovcli.conf` 路径是 `~/.openviking/ovcli.conf`（`~` = 用户目录） |
| API Key 无效 | 联系管理员确认 Key 是否正确、账号状态是否正常 |
| 服务器无响应 | `curl http://192.168.2.200:1933/health` 检查连通性 |
| CC 插件未加载 | `claude plugin list` 确认 `openviking-memory@openviking` 在列表中 |
| CC 插件版本过旧 | 当前服务器 v0.4.10；若插件版本滞后可重新安装 |
| OpenClaw MCP 不通 | 确认 `mcp-adapter` 已安装 + `openclaw gateway restart` |

---

> 需要更多信息？查看 [完整使用指南](OpenViking-使用指南.md)（管理员操作、账号管理、API 速查）
