// Analyze BOOS sessions vs Claude conversation files
const fs = require('fs');
const path = require('path');
const os = require('os');

const home = os.homedir();
const projectsDir = path.join(home, '.claude', 'projects');
const sessionsFile = path.join(home, '.boos', 'sessions.json');

const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
const agentKeywords = ['前端', '后端', '测试', '项目经理'];

// Get all project slugs with their cwds
const slugCwds = new Map();
const slugs = fs.readdirSync(projectsDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

for (const slug of slugs) {
  const slugDir = path.join(projectsDir, slug);
  try {
    const files = fs.readdirSync(slugDir).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) continue;
    const firstFile = path.join(slugDir, files[0]);
    const head = fs.readFileSync(firstFile, 'utf8').split('\n')[0];
    const obj = JSON.parse(head);
    if (obj.cwd) {
      slugCwds.set(slug, obj.cwd);
    }
  } catch {}
}

console.log('=== Agent Sessions ===');
console.log('ID (last8) | Status   | cliSessionId? | CWD basename | Claude Project');
console.log('-'.repeat(80));

for (const s of sessions) {
  const bn = path.basename(s.cwd || '');
  if (!agentKeywords.some(k => bn.includes(k))) continue;

  // Find matching project slug
  let matchedSlug = null;
  for (const [slug, cwd] of slugCwds) {
    if (cwd.toLowerCase() === (s.cwd || '').toLowerCase()) {
      matchedSlug = slug;
      break;
    }
  }

  const hasSid = s.cliSessionId ? '✅' : '❌';
  const shortSid = s.cliSessionId ? s.cliSessionId.slice(0, 13) + '...' : '(null)';
  console.log(`${s.id.slice(-10).padEnd(11)} ${s.status.padEnd(9)} ${hasSid} ${shortSid.padEnd(20)} ${bn.padEnd(16)} ${matchedSlug || 'NOT FOUND'}`);
}

console.log('');
console.log('=== Unique agent cwds ===');
const seenCwds = new Set();
for (const s of sessions) {
  const bn = path.basename(s.cwd || '');
  if (!agentKeywords.some(k => bn.includes(k))) continue;
  if (seenCwds.has(s.cwd)) continue;
  seenCwds.add(s.cwd);
  const hasSid = s.cliSessionId ? '✅' : '❌';
  console.log(`${hasSid} ${s.cwd}`);
}
