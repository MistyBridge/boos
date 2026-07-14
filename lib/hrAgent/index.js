// HR Agent — embedded recruitment system for BOOS.
//
// Sprint 8 #65: automatically recruits specialist agents from D:\AI_Ex\HR\
// role templates. Runs silently within the BOOS process, responds to
// agent-bus tasks sent to the HR Agent's UID.
//
// Recruitment flow:
//   PM: send_task(to_uid=hrUid, content="招募测试工程师")
//   HR Agent: parse → lookup role → gen config → register agent → respond

'use strict';

const path = require('path');
const fs = require('node:fs');

const HR_BASE = 'D:\\AI_Ex\\HR';
const ROLES_DIR = path.join(HR_BASE, 'roles');
const REGISTRY_PATH = path.join(HR_BASE, 'registry.json');
const TEMPLATES_DIR = path.join(HR_BASE, 'templates');

// ── role template loading ──────────────────────────────────────────────

function loadRoleTemplates() {
  const roles = {};
  try {
    const files = fs.readdirSync(ROLES_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(ROLES_DIR, file), 'utf-8');
        const role = JSON.parse(raw);
        roles[role.role] = role;
      } catch {}
    }
  } catch (e) {
    console.warn('[boos] HR Agent: cannot read roles from', ROLES_DIR, e.message);
  }
  return roles;
}

function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch {
    return { skills: {}, mcps: {} };
  }
}

// ── role matching ──────────────────────────────────────────────────────

// Chinese-to-English keyword aliases for role matching.
const CN_ALIASES = {
  '测试': 'qa-engineer', '测试工程师': 'qa-engineer', 'qa': 'qa-engineer',
  '前端': 'frontend-developer', '前端开发': 'frontend-developer', 'frontend': 'frontend-developer',
  '后端': 'backend-developer', '后端开发': 'backend-developer', 'backend': 'backend-developer',
  '全栈': 'fullstack-developer', 'fullstack': 'fullstack-developer',
  'devops': 'devops-engineer', '运维': 'devops-engineer',
  '安全': 'security-engineer', 'security': 'security-engineer',
  '数据': 'data-engineer', 'data': 'data-engineer',
  '架构师': 'software-architect', '架构': 'software-architect',
  'ui': 'ui-designer', '设计': 'ui-designer', '设计师': 'ui-designer',
  '机器学习': 'ml-training-engineer', 'ml': 'ml-training-engineer',
  '系统': 'systems-engineer', 'systems': 'systems-engineer',
};

function findRoleTemplate(request, roles) {
  const q = request.toLowerCase();

  // Check Chinese aliases first.
  for (const [cn, roleKey] of Object.entries(CN_ALIASES)) {
    if (q.includes(cn) && roles[roleKey]) return roles[roleKey];
  }

  // Direct match on role key.
  for (const [key, role] of Object.entries(roles)) {
    if (q.includes(key) || q.includes(role.title?.toLowerCase())) return role;
  }

  // Match on category or typical tasks.
  for (const [, role] of Object.entries(roles)) {
    const tasks = (role.typical_tasks || []).join(' ').toLowerCase();
    if (q.split(/\s+/).some((w) => tasks.includes(w) && w.length > 2)) return role;
  }

  return null;
}

// ── config generation ──────────────────────────────────────────────────

function generateClaudeMd(role, agentName, project) {
  const skills = role.skills || {};
  const mcps = role.mcps || {};

  return `# ${agentName} — BOOS ${project || ''} Team

> **Role**: ${role.title || role.role}
> **Project**: ${project || 'boos'}
> **Recruited by**: HR Agent

## Capabilities
${(skills.required || []).map((s) => `- ${s}`).join('\n')}

## Available MCPs
${(mcps.required || []).map((m) => `- ${m}`).join('\n')}

## Typical Tasks
${(role.typical_tasks || []).map((t) => `- ${t}`).join('\n')}

## Communication Protocol
- Check agent-bus inbox every 30s with check_inbox({wait: false})
- Respond to all tasks via respond_task
- Report progress before starting each task
- Ask for clarification via reply_to if requirements are unclear

## Work Boundary
- Focus on ${role.title || role.role} tasks only
- Forward unrelated tasks to 通用助手 (generalist agent)
- Report task type distribution to PM weekly
`;
}

function generateMcpJson(role, agentBusUrl) {
  const mcps = role.mcps || {};
  const required = mcps.required || [];
  const optional = mcps.optional || [];

  const servers = {};

  // Agent-bus is always required for communication.
  servers['agent-bus'] = {
    type: 'sse',
    url: agentBusUrl || 'http://127.0.0.1:7780/mcp/sse',
  };

  for (const mcp of required) {
    if (mcp === 'agent-bus') continue;
    servers[mcp] = { type: 'stdio', command: 'npx', args: ['-y', `@anthropic/mcp-${mcp}`] };
  }

  return { mcpServers: servers };
}

// ── recruitment handler ────────────────────────────────────────────────

async function handleRecruitRequest(request, agentBusUrl, store, registry) {
  const roles = loadRoleTemplates();

  const role = findRoleTemplate(request, roles);
  if (!role) {
    return { ok: false, error: `no matching role found for: "${request}". Available: ${Object.keys(roles).join(', ')}` };
  }

  // Parse project from request.
  const projectMatch = request.match(/(?:加入|project[:=]\s*|项目[:=]\s*)(\S+)/i);
  const project = projectMatch ? projectMatch[1] : null;

  const agentName = role.title || role.role;
  const capabilities = [
    ...(role.skills?.required || []),
    ...(role.skills?.optional || []).slice(0, 5),
    role.category || role.role,
  ].slice(0, 10);

  // Register agent in agent-bus.
  let result;
  try {
    result = await registry.registerAgent({
      name: agentName,
      intro: `BOOS ${agentName} — ${role.description || ''}`.slice(0, 256),
      workspace: 'boos',
      role: 'worker',
      capabilities,
      project,
    });
  } catch (e) {
    return { ok: false, error: `failed to register agent: ${e.message}` };
  }

  // Generate configs.
  const claudeMd = generateClaudeMd(role, agentName, project);
  const mcpJson = generateMcpJson(role, agentBusUrl);

  return {
    ok: true,
    agent_uid: result.uid,
    agent_name: agentName,
    project,
    role_template: role.role,
    capabilities,
    configs: {
      'CLAUDE.md': claudeMd,
      '.mcp.json': mcpJson,
    },
    hint: `Agent ${agentName} registered. Create a BOOS session at ~/boos-workspaces/${agentName}/ with these config files to activate.`,
  };
}

// ── list available roles ───────────────────────────────────────────────

function listAvailableRoles() {
  const roles = loadRoleTemplates();
  return Object.values(roles).map((r) => ({
    role: r.role,
    title: r.title,
    category: r.category,
    level: r.level,
    skills_count: (r.skills?.required || []).length + (r.skills?.optional || []).length,
  }));
}

module.exports = {
  handleRecruitRequest,
  listAvailableRoles,
  findRoleTemplate,
  loadRoleTemplates,
  HR_BASE,
};
