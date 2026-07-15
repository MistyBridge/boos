// BOOS HR Agent — automated role recruitment system.
//
// Sprint 8 #65 #66 + Sprint 11 refinement:
// When a supervisor sends a recruitment task to the HR Agent, this module:
//   1. Parses the request for role template, agent name, project, capabilities
//   2. Creates the agent directory under claudes/<agent-name>/
//   3. Writes .claude/CLAUDE.md from the role template
//   4. Writes .mcp.json with the standard MCP server set + agent-bus endpoint
//   5. Registers the agent in the agent-bus store
//   6. Creates a BOOS session so the agent appears on the dashboard immediately
//   7. Assigns the session to the project folder in the sidebar
//
// Role templates are stored in D:\AI_Ex\HR\ as markdown files. A built-in
// set of templates is also defined below for offline use.

'use strict';

const path = require('path');
const fs = require('fs');

// ── Project root ────────────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLAUDES_DIR = path.join(PROJECT_ROOT, 'claudes');
const MCP_SHARED_DIR = path.join(CLAUDES_DIR, '.mcp');

// ── Built-in role templates ─────────────────────────────────────────────

const BUILTIN_ROLES = [
  {
    id: 'frontend-engineer',
    title: '前端工程师',
    capabilities: ['frontend', 'ui', 'css', 'preact', 'xterm.js', 'responsive'],
    intro: 'BOOS Preact UI 开发 — 负责 WorkspacePage、AgentCanvas、AgentNode、xterm.js 终端集成、CSS Design Tokens 体系',
    claudeMd: `# BOOS — 前端工程师

## 你是前端工程师

负责 BOOS 所有用户界面。桌面级 Web App，对标 claude.ai 交互体验。

## 项目路径

- **项目根**: \`D:\\AI IDE\\CC_BOOS\`
- **前端源码**: \`public/js/\` — 入口 \`main.js\`，状态 \`state.js\`
- **CSS**: \`public/css/\` — 12 个主题文件
- **组件**: \`public/js/components/\`

## 技术栈

| 技术 | 用途 |
|------|------|
| Preact + Signals | 细粒度响应式 UI |
| htm | JSX-free 模板 |
| xterm.js | 终端模拟器 |
| CSS Custom Properties | Design Tokens |
| Pointer Events API | 拖拽/缩放/resize |

## 工作流

1. 启动 → register_agent(name="前端工程师", workspace="boos")
2. check_inbox 等待任务
3. 完成后 respond_task + update_knowledge
4. 修改 public/ 下文件前 request_file_lock`,
  },
  {
    id: 'platform-engineer',
    title: '平台集成工程师',
    capabilities: ['integration', 'mcp', 'sse', 'cross-platform', 'agent-bus'],
    intro: 'BOOS 与外部系统的桥梁。负责 Agent-Bus 集成稳定性、MCP 协议合规性、跨平台适配（macOS/Linux）。',
    claudeMd: `# BOOS — 平台集成工程师

## 你是平台集成工程师

负责 BOOS agent-bus 集成、MCP 协议、SSE 通信、跨平台适配。

## 项目路径

- **项目根**: \`D:\\AI IDE\\CC_BOOS\`
- **Agent-Bus**: \`lib/agentBus/\`
- **MCP 传输层**: \`lib/agentBus/transport.js\`

## 技术栈

| 技术 | 用途 |
|------|------|
| MCP 2024-11-05 | Agent 通信协议 |
| SSE | 实时事件推送 |
| Node.js | 后端运行时 |
| node-pty | PTY 管理 |

## 工作流

1. 启动 → register_agent(name="平台集成工程师", workspace="boos")
2. check_inbox 等待任务
3. 修改 lib/agentBus/ 前 request_file_lock`,
  },
  {
    id: 'reliability-engineer',
    title: '可靠性工程师',
    capabilities: ['testing', 'e2e', 'security', 'ci', 'performance'],
    intro: 'BOOS 测试体系建设 — 单元测试(node:test)、E2E(Playwright)、覆盖率(c8)、CI/CD(GitHub Actions)、压测(autocannon)',
    claudeMd: `# BOOS — 可靠性工程师

## 你是可靠性工程师

负责 BOOS 测试体系、CI/CD、性能和安全审计。

## 项目路径

- **项目根**: \`D:\\AI IDE\\CC_BOOS\`
- **测试**: \`tests/\`
- **CI**: \`.github/workflows/\`

## 技术栈

| 技术 | 用途 |
|------|------|
| node:test | 单元测试 |
| c8 | 覆盖率 |
| Playwright | E2E |
| autocannon | 压测 |

## 工作流

1. 启动 → register_agent(name="可靠性工程师", workspace="boos")
2. check_inbox 等待任务
3. 每个测试文件独立、可并行运行`,
  },
  {
    id: 'backend-engineer',
    title: '后端工程师',
    capabilities: ['backend', 'nodejs', 'express', 'api', 'database'],
    intro: 'BOOS 后端开发 — Express 路由、REST API、WebSocket、数据库操作',
    claudeMd: `# BOOS — 后端工程师

## 你是后端工程师

负责 BOOS Express 服务器、API 路由、WebSocket 和数据库。

## 项目路径

- **项目根**: \`D:\\AI IDE\\CC_BOOS\`
- **路由**: \`routes/\`
- **核心库**: \`lib/\`

## 技术栈

| 技术 | 用途 |
|------|------|
| Express | HTTP 服务 |
| ws | WebSocket |
| node-pty | 终端 |
| PostgreSQL | 持久化(计划中) |

## 工作流

1. 启动 → register_agent(name="后端工程师", workspace="boos")
2. 修改 server.js 或 lib/ 前 request_file_lock`,
  },
  {
    id: 'devops-engineer',
    title: 'DevOps 工程师',
    capabilities: ['devops', 'docker', 'ci', 'deployment', 'monitoring'],
    intro: 'BOOS DevOps — Docker 容器管理、CI/CD 流水线、部署自动化、监控',
    claudeMd: `# BOOS — DevOps 工程师

## 你是 DevOps 工程师

负责 BOOS Docker 部署、CI/CD 流水线和监控。

## 项目路径

- **项目根**: \`D:\\AI IDE\\CC_BOOS\`
- **CI**: \`.github/workflows/\`
- **Docker**: 计划中

## 工作流

1. 启动 → register_agent(name="DevOps 工程师", workspace="boos")`,
  },
  {
    id: 'data-engineer',
    title: '数据工程师',
    capabilities: ['data', 'postgresql', 'etl', 'analytics'],
    intro: 'BOOS 数据层 — PostgreSQL 数据库管理、对话同步、数据分析',
    claudeMd: `# BOOS — 数据工程师

## 你是数据工程师

负责 BOOS PostgreSQL 数据库管理和对话记忆同步。

## 项目路径

- **项目根**: \`D:\\AI IDE\\CC_BOOS\`

## 工作流

1. 启动 → register_agent(name="数据工程师", workspace="boos")`,
  },
];

// ── MCP config template ────────────────────────────────────────────────

function _mcpConfig(agentBusUrl) {
  return {
    mcpServers: {
      filesystem: {
        command: 'node',
        args: [path.join(MCP_SHARED_DIR, 'filesystem', 'dist', 'index.js'), PROJECT_ROOT],
      },
      'sequential-thinking': {
        command: 'node',
        args: [path.join(MCP_SHARED_DIR, 'node_modules', '@modelcontextprotocol', 'server-sequential-thinking', 'dist', 'index.js')],
      },
      'agent-bus': {
        type: 'sse',
        url: agentBusUrl || 'http://127.0.0.1:7780/mcp/sse',
      },
    },
  };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * List all available role templates (built-in + HR asset directory).
 */
function listAvailableRoles() {
  const roles = [...BUILTIN_ROLES];

  // Try to load additional roles from HR asset directory.
  try {
    const hrDir = 'D:\\AI_Ex\\HR';
    if (fs.existsSync(hrDir)) {
      const files = fs.readdirSync(hrDir).filter((f) => f.endsWith('.md'));
      for (const f of files) {
        const content = fs.readFileSync(path.join(hrDir, f), 'utf-8');
        const parsed = _parseHrTemplate(f.replace('.md', ''), content);
        if (parsed) roles.push(parsed);
      }
    }
  } catch {}

  return roles;
}

/**
 * Handle a recruitment request. Parses natural-language content for:
 *   - Role template (required): matches against known role titles/aliases
 *   - Agent name (optional): defaults to role title
 *   - Project (optional): assigns the agent to a project
 *   - Capabilities override (optional): custom capability list
 *
 * @param {string} content — recruitment request text
 * @param {string|null} agentBusUrl — MCP SSE endpoint for agent-bus
 * @param {object} store — agent-bus store
 * @param {object} registry — agent-bus registry
 * @returns {Promise<{ok: boolean, agent_uid?: string, agent_name?: string,
 *   session_id?: string, role_template?: string, capabilities?: string[],
 *   error?: string, hint?: string}>}
 */
async function handleRecruitRequest(content, agentBusUrl, store, registry) {
  // Parse request.
  const parsed = _parseRecruitRequest(content);
  if (!parsed.role) {
    const roles = listAvailableRoles().map((r) => r.title).join(', ');
    return { ok: false, error: '未指定角色模板。可用角色: ' + roles };
  }

  // Find role template.
  const role = _findRole(parsed.role);
  if (!role) {
    const roles = listAvailableRoles().map((r) => r.title + '(' + r.id + ')').join(', ');
    return { ok: false, error: '未找到角色 "' + parsed.role + '"。可用: ' + roles };
  }

  const agentName = parsed.name || role.title;

  // 1. Check for duplicate.
  const existing = store.findAgentByNameWs(agentName, 'boos');
  if (existing) {
    return {
      ok: false,
      error: 'agent "' + agentName + '" 已存在 (uid: ' + existing.uid + ')。如需重建请先用 kill_worker 移除。',
    };
  }

  // 2. Create agent directory under claudes/<agent-name>/.
  const agentDir = path.join(CLAUDES_DIR, agentName);
  const claudeDir = path.join(agentDir, '.claude');
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: '无法创建目录 ' + agentDir + ': ' + e.message };
  }

  // 3. Write .claude/CLAUDE.md.
  try {
    const md = _fillTemplate(role.claudeMd, agentName, parsed.project || 'boos');
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), md, 'utf-8');
  } catch (e) {
    return { ok: false, error: '无法写入 CLAUDE.md: ' + e.message };
  }

  // 4. Write .mcp.json.
  try {
    const mcp = _mcpConfig(agentBusUrl);
    fs.writeFileSync(path.join(agentDir, '.mcp.json'), JSON.stringify(mcp, null, 2), 'utf-8');
  } catch (e) {
    return { ok: false, error: '无法写入 .mcp.json: ' + e.message };
  }

  // 5. Register in agent-bus.
  const capabilities = parsed.capabilities || role.capabilities;
  const regResult = await registry.registerAgent({
    name: agentName,
    intro: role.intro,
    workspace: 'boos',
    role: 'worker',
    capabilities,
    project: parsed.project || null,
  });

  if (!regResult.ok) {
    return { ok: false, error: 'agent-bus 注册失败: ' + (regResult.error || 'unknown') };
  }

  // 6. Create BOOS session — auto-appears on dashboard.
  let sessionId = null;
  try {
    sessionId = await _createBoosSession(agentName, agentDir);
  } catch (e) {
    // Non-fatal: agent is registered, just doesn't have a live PTY yet.
  }

  return {
    ok: true,
    agent_uid: regResult.uid,
    agent_name: agentName,
    session_id: sessionId,
    role_template: role.id,
    directory: agentDir,
    capabilities,
    project: parsed.project || null,
    hint: sessionId
      ? 'Agent 已创建并导入仪表盘。会话 ID: ' + sessionId
      : 'Agent 已注册。启动会话: POST /api/sessions/new {cliId:"claude", cwd:"' + agentDir + '"}',
  };
}

// ── Internal helpers ────────────────────────────────────────────────────

function _findRole(name) {
  const roles = listAvailableRoles();
  const lower = name.toLowerCase().trim();
  return roles.find((r) =>
    r.title === name ||
    r.id === lower ||
    r.title.includes(name) ||
    name.includes(r.title) ||
    r.capabilities.some((c) => c === lower),
  );
}

function _parseRecruitRequest(content) {
  const text = String(content || '');
  const result = { role: null, name: null, project: null, capabilities: null };

  // Pattern 1: Structured fields.
  const roleMatch = text.match(/角色[：:]\s*(.+?)(?:\n|$)/i) || text.match(/招募\s+(.+?)(?:\n|$)/i);
  if (roleMatch) result.role = roleMatch[1].trim();

  const nameMatch = text.match(/名称[：:]\s*(.+?)(?:\n|$)/i) || text.match(/(?:叫|命名(?:为)?)[：:]?\s*(.+?)(?:\n|$)/i);
  if (nameMatch) result.name = nameMatch[1].trim();

  const projMatch = text.match(/项目[：:]\s*(.+?)(?:\n|$)/i);
  if (projMatch) result.project = projMatch[1].trim();

  const capMatch = text.match(/能[力力][：:]\s*(.+?)(?:\n|$)/i) || text.match(/capabilit(?:y|ies)[：:]\s*(.+?)(?:\n|$)/i);
  if (capMatch) result.capabilities = capMatch[1].split(/[,，、]/).map((s) => s.trim().toLowerCase()).filter(Boolean);

  // Pattern 2: Natural language — "招募一个前端工程师叫小明 能力: react, css"
  if (!result.role) {
    // Try to match a known role title in the text.
    const roles = listAvailableRoles();
    for (const r of roles) {
      if (text.includes(r.title) || text.includes(r.id)) {
        result.role = r.title;
        break;
      }
    }
  }

  return result;
}

function _fillTemplate(template, agentName, project) {
  return template
    .replace(/\{\{AGENT_NAME\}\}/g, agentName)
    .replace(/\{\{PROJECT\}\}/g, project || 'boos');
}

function _parseHrTemplate(id, content) {
  // Parse simple markdown HR templates.
  const titleMatch = content.match(/^#\s+(.+)/m);
  const capMatch = content.match(/^capabilit(?:y|ies)\s*:\s*(.+)/im);
  if (!titleMatch) return null;
  return {
    id,
    title: titleMatch[1].trim(),
    capabilities: capMatch ? capMatch[1].split(/[,，、]/).map((s) => s.trim()) : [],
    intro: '',
    claudeMd: content,
  };
}

/**
 * Create a BOOS session for the newly recruited agent so it appears
 * on the dashboard immediately.
 */
async function _createBoosSession(agentName, cwd) {
  let persistedSessions, loadConfig, findCliById, spawnSessionRecord, folders;

  try {
    persistedSessions = require('./persistedSessions');
    const cfg = require('./config');
    loadConfig = cfg.loadConfig;
  } catch {}

  try { findCliById = require('./cliHelpers').findCliById; } catch {}
  try { spawnSessionRecord = require('./sessionHelpers').getSpawnSessionRecord(); } catch {}
  try { folders = require('./folders'); } catch {}

  if (!persistedSessions || !loadConfig) return null;

  const config = await loadConfig();
  const cliId = config.defaultCliId || 'claude';
  const cli = findCliById ? findCliById(config, cliId) : { command: 'claude', args: [] };

  // Generate a session ID.
  const { genId } = require('./webTerminal');
  const sessionId = genId ? genId() : 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  // Determine workspace name.
  const workspace = path.basename(cwd);

  // Find or create a folder for this project.
  let folderId = null;
  if (folders) {
    try {
      const allFolders = await folders.loadAll();
      // Try to find a folder matching the project.
      const match = allFolders.find((f) => f.name === 'BOOS Agents' || f.name === workspace);
      if (match) {
        folderId = match.id;
      } else {
        // Create a "BOOS Agents" folder if it doesn't exist.
        const created = await folders.create({ name: 'BOOS Agents' });
        folderId = created.id;
      }
    } catch {}
  }

  // Persist the session record.
  const record = {
    id: sessionId,
    cliId,
    cwd,
    workspace,
    title: agentName,
    folderId,
    repos: [],
    status: 'running',
    manualStopped: false,
  };

  try {
    await persistedSessions.save(record);
  } catch {}

  // Try to spawn the PTY if spawnSessionRecord is available.
  if (spawnSessionRecord) {
    try {
      await spawnSessionRecord({ record, cli, cfg: config, body: {}, resume: false });
      await persistedSessions.markRunning(sessionId);
    } catch {}
  }

  return sessionId;
}

module.exports = { listAvailableRoles, handleRecruitRequest };
