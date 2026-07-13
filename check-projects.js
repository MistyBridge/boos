const fs = require('fs');
const path = require('path');
const os = require('os');
const home = os.homedir();

const projectsDir = path.join(home, '.claude', 'projects');
const slugs = fs.readdirSync(projectsDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

const agentDirs = [
  'D:\\\\web\\\\quant-dashboard\\\\claudes\\\\前端开发工程师',
  'D:\\\\web\\\\quant-dashboard\\\\claudes\\\\后端开发工程师',
  'D:\\\\web\\\\quant-dashboard\\\\claudes\\\\测试工程师',
  'D:\\\\web\\\\quant-dashboard\\\\claudes\\\\项目经理',
];

console.log('=== Claude Projects matching agent cwds ===');
for (const slug of slugs) {
  const slugDir = path.join(projectsDir, slug);
  let files;
  try { files = fs.readdirSync(slugDir).filter(f => f.endsWith('.jsonl')); }
  catch { continue; }
  if (files.length === 0) continue;

  for (const file of files.slice(0, 5)) {
    try {
      const text = fs.readFileSync(path.join(slugDir, file), 'utf8');
      const lines = text.split('\n').slice(0, 5);
      for (const line of lines) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line);
        if (obj.cwd) {
          const lower = obj.cwd.toLowerCase();
          for (const ac of agentDirs) {
            if (lower === ac.toLowerCase()) {
              const agentName = ac.split('\\').pop();
              console.log(slug, '->', agentName, '| files:', files.length, '| id:', file.replace('.jsonl','').slice(0,13)+'...');
            }
          }
          break;
        }
      }
    } catch {}
  }
}

console.log('');
console.log('=== Checking cliSessionId validity ===');
const sessionsFile = path.join(home, '.boos', 'sessions.json');
const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
const agentNames = ['前端开发工程师', '后端开发工程师', '测试工程师', '项目经理'];

// Build set of all jsonl file paths for quick lookup
const allJsonls = new Set();
const jsonlMap = new Map(); // filename (no ext) -> filepath
for (const slug of slugs) {
  const slugDir = path.join(projectsDir, slug);
  let files;
  try { files = fs.readdirSync(slugDir).filter(f => f.endsWith('.jsonl')); }
  catch { continue; }
  for (const f of files) {
    const id = f.replace('.jsonl', '');
    allJsonls.add(path.join(slugDir, f));
    if (!jsonlMap.has(id)) jsonlMap.set(id, path.join(slugDir, f));
  }
}

for (const s of sessions) {
  const bn = path.basename(s.cwd || '');
  if (!agentNames.some(a => bn.includes(a) || bn === a)) continue;
  if (!s.cliSessionId) continue;

  const jsonlPath = jsonlMap.get(s.cliSessionId);
  if (jsonlPath) {
    const stat = fs.statSync(jsonlPath);
    const ageMin = Math.round((Date.now() - stat.mtimeMs) / 60000);
    console.log('OK', bn, s.cliSessionId.slice(0,13)+'...', 'mtime:', ageMin+'min ago', 'size:', Math.round(stat.size/1024)+'KB');
  } else {
    console.log('MISSING', bn, s.cliSessionId.slice(0,13)+'...', 'NOT IN ANY PROJECT');
  }
}

console.log('');
console.log('=== Sessions WITHOUT cliSessionId (agent cwds only) ===');
for (const s of sessions) {
  const bn = path.basename(s.cwd || '');
  if (!agentNames.some(a => bn.includes(a) || bn === a)) continue;
  if (s.cliSessionId) continue;
  console.log(s.id.slice(-10), bn, s.cwd, 'status:', s.status);
}
