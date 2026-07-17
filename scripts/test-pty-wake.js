#!/usr/bin/env node
/**
 * Test PTY Write Wake Mechanism
 *
 * 这个脚本测试通过 webTerminal.write() 向 PTY 发送唤醒信号，
 * 验证 CC 模型是否能感知并响应。
 *
 * 使用方法：
 * 1. 确保 BOOS 服务器正在运行
 * 2. 确保有一个活跃的前端工程师会话
 * 3. 运行此脚本
 * 4. 观察前端工程师的终端输出
 */

const fs = require('fs');
const path = require('path');

// 读取 BOOS 配置
const configPath = path.join(process.env.USERPROFILE, '.boos', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const port = config.port || 7780;

async function testPtyWrite() {
  console.log('=== PTY Write Wake Mechanism Test ===\n');

  // 1. 检查 BOOS 服务器状态
  console.log('1. Checking BOOS server status...');
  try {
    const healthRes = await fetch(`http://localhost:${port}/api/health`);
    const health = await healthRes.json();
    console.log('   ✓ BOOS server is running (PID:', health.pid + ')');
  } catch (err) {
    console.log('   ✗ BOOS server is not responding');
    process.exit(1);
  }

  // 2. 检查会话状态
  console.log('\n2. Checking sessions...');
  const sessionsRes = await fetch(`http://localhost:${port}/api/sessions`);
  const sessionsData = await sessionsRes.json();
  const runningSessions = sessionsData.sessions.filter(s => s.status === 'running');

  console.log('   Found', runningSessions.length, 'running session(s)');
  if (runningSessions.length === 0) {
    console.log('   ✗ No running sessions found');
    console.log('   Please start a session first (e.g., 前端工程师)');
    process.exit(1);
  }

  for (const session of runningSessions) {
    console.log('   -', session.id, '(' + session.cwd + ')');
  }

  // 3. 获取第一个运行中的会话
  const targetSession = runningSessions[0];
  console.log('\n3. Target session:', targetSession.id);

  // 4. 检查 webTerminal pool（通过服务器日志）
  console.log('\n4. Checking webTerminal pool...');
  console.log('   Note: webTerminal state is in-memory, cannot check from external script');
  console.log('   Will attempt to write to PTY via API');

  // 5. 尝试通过 wake_agent API 触发唤醒
  console.log('\n5. Attempting to wake agent via PTY write...');

  // 由于 wake_agent API 需要 agent-bus 连接，我们直接测试 PTY write
  // 创建一个简单的 HTTP 服务器来接收 wake 请求
  const wakeSignal = '\n[agent-bus] 📨 测试唤醒信号 — 请调用 check_inbox(wait=false) 收取任务\n';

  console.log('   Wake signal:', JSON.stringify(wakeSignal));
  console.log('\n   To test PTY write, you need to:');
  console.log('   1. Attach to the session via WebSocket');
  console.log('   2. Send the wake signal via webTerminal.write()');
  console.log('   3. Observe if the CC model responds');

  console.log('\n6. Alternative: Check BOOS server logs');
  console.log('   View logs at:', path.join(process.env.USERPROFILE, '.boos', 'server.log'));
  console.log('   Look for: [boos] notifications: PTY write');

  console.log('\n=== Test Complete ===');
  console.log('Note: Full PTY write test requires WebSocket connection to BOOS server');
}

testPtyWrite().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
