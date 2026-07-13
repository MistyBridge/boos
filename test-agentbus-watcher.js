// Full E2E test: agent-bus → BOOS watcher → PTY wake-up
//
// 1. Create BOOS session entry (like resumed agent)
// 2. Spawn PTY in webTerminal with same session ID
// 3. Register agent in agent-bus
// 4. Send task (0→1 transition)
// 5. Verify BOOS watcher writes wake-up message to PTY

const path = require('path');
const webTerminal = require('D:/AI_Ex/GUI/lib/webTerminal');
const persistedSessions = require('D:/AI_Ex/GUI/lib/persistedSessions');

const AGENT_BUS = 'http://127.0.0.1:7778/api/call';

async function apiCall(sessionId, toolName, args = {}) {
  const body = JSON.stringify({ toolName, args, sessionId });
  const resp = await fetch(AGENT_BUS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return resp.json();
}

(async () => {
  console.log('=== E2E: task → SSE → BOOS watcher → PTY wake-up ===\n');

  const workspace = 'e2e-ws-' + Date.now();
  const agentName = 'E2E测试Agent';

  // 1. Create BOOS session entry
  const cwd = path.join(process.cwd(), 'boos-workspaces', agentName);
  const session = await persistedSessions.create({
    cliId: 'claude',
    cwd,
    workspace,
    title: agentName,
    status: 'running',
  });
  console.log('1. BOOS session created:', session.id.slice(-10), 'cwd:', cwd);

  // 2. Spawn PTY (uses cmd.exe for test, Claude would use claude CLI)
  if (!webTerminal.available) {
    console.error('node-pty not available');
    process.exit(1);
  }

  let ptyOutput = '';
  const entry = webTerminal.spawn('cmd.exe', [], {
    cwd: process.cwd(),
    cols: 120, rows: 40,
    id: session.id,  // use EXACT session ID so watcher can find it
    meta: { command: 'cmd.exe', cwd: process.cwd() },
    onData: (data) => { ptyOutput += data; },
    onExit: () => {},
  });
  await persistedSessions.markRunning(session.id, entry.meta.pid);
  console.log('2. PTY spawned with session ID:', entry.id.slice(-10), 'pid:', entry.meta.pid);

  // 3. Register agent in agent-bus (same name as session cwd basename)
  const reg = await apiCall('e2e-sess', 'register_agent', {
    name: agentName,
    intro: 'E2E test agent',
    workspace,
  });
  console.log('3. Agent-bus agent registered:', reg.uid, 'reconnected:', reg.reconnected);

  // 4. Send task from another agent
  const senderSid = 'e2e-sender';
  await apiCall(senderSid, 'register_agent', {
    name: 'E2E发送者',
    intro: 'E2E sender',
    workspace,
  });

  const sendResult = await apiCall(senderSid, 'send_task', {
    to_uid: reg.uid,
    content: 'E2E test: wake up and process this task!',
  });
  console.log('4. Task sent:', sendResult.ok, 'was_empty:', sendResult.was_empty);

  // 5. Wait for watcher to process
  console.log('5. Waiting for BOOS watcher to write to PTY...');
  await new Promise(r => setTimeout(r, 3000));

  // 6. Check PTY output for wake-up message
  console.log('\n=== PTY Output ===');
  // Filter to show relevant lines
  const lines = ptyOutput.split('\n').filter(l => l.includes('agent-bus') || l.includes('check_inbox') || l.includes('E2E'));
  if (lines.length > 0) {
    console.log('✅ PTY received wake-up message!');
    for (const line of lines) console.log('   ', line.trim());
  } else {
    console.log('All PTY output (first 500 chars):');
    console.log(ptyOutput.slice(0, 500));
  }

  // Cleanup
  try { entry.pty.kill(); } catch {}
  await persistedSessions.markExited(session.id, 0);
  console.log('\n🎉 E2E test complete');
})().catch(e => { console.error(e); process.exit(1); });
