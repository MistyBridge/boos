// Fix mcp-proxy.js with auto-retry on disconnect
const fs = require('fs');
const path = require('path');
const f = path.join(process.env.USERPROFILE, '.boos', 'mcp-proxy.js');
let s = fs.readFileSync(f, 'utf8');

// Replace the SSE connection block (line 25-72)
const marker1 = "function _send(msg)";
const marker2 = "// ── stdin → POST /mcp/message";
const idx1 = s.indexOf(marker1);
const idx2 = s.indexOf(marker2);

const newConn = `function _send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }

// ── SSE connection with auto-retry (Sprint 17) ────────────────────────
let sessionId = null;
let initialized = false;
let buf = '';
let _connecting = false;
let _retryTimer = null;

function _readPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(BOOS_HOME, 'config.json'), 'utf-8'));
    if (cfg.port > 0) return cfg.port;
  } catch {}
  return 7780;
}

function _connectSSE() {
  if (_connecting) return;
  _connecting = true;
  if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }

  const currentPort = _readPort();
  sessionId = null;
  initialized = false;
  buf = '';

  const sseReq = http.get('http://localhost:' + currentPort + '/mcp/sse', { headers: { Accept: 'text/event-stream' } }, (sseRes) => {
    _connecting = false;
    sseRes.setEncoding('utf-8');
    sseRes.on('data', (chunk) => {
      buf += chunk;
      if (!sessionId) {
        const m = buf.match(/sessionId=([^\\s&\\n]+)/);
        if (m) {
          sessionId = m[1];
          _post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
            protocolVersion: '2024-11-05', capabilities: {},
            clientInfo: { name: 'boos-mcp-proxy', version: '1.0.0' },
          }});
        }
      }
      const events = buf.split(/\\n\\n/);
      buf = events.pop();
      for (const ev of events) {
        for (const line of ev.split('\\n')) {
          if (line.startsWith('data: ')) {
            try {
              const msg = JSON.parse(line.slice(6));
              if (msg.id === 0) {
                initialized = true;
                _send({ jsonrpc: '2.0', id: 0, result: msg.result });
              } else if (msg.id !== -1) {
                _send(msg);
              }
            } catch {}
          }
        }
      }
    });
    sseRes.on('error', () => { _connecting = false; _retryTimer = setTimeout(_connectSSE, 2000); });
    sseRes.on('end', () => { _connecting = false; _retryTimer = setTimeout(_connectSSE, 2000); });
  });
  sseReq.on('error', () => { _connecting = false; _retryTimer = setTimeout(_connectSSE, 2000); });
}

_connectSSE();

`;

s = s.slice(0, idx1) + newConn + s.slice(idx2);
fs.writeFileSync(f, s);
console.log('mcp-proxy.js: auto-retry on disconnect added');
