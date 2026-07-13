// Feishu (Lark) webhook integration — sends interactive card messages
// for urgent agent decisions.  Fire-and-forget: never throws, logs warnings.
//
// Config (in ~/.boos/config.json):
//   "feishu": {
//     "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
//     "secretKey": "optional-signing-key"
//   }

'use strict';

const https = require('node:https');

// ── optional HMAC-SHA256 signing ──────────────────────────────────────

let _crypto;
try {
  _crypto = require('node:crypto');
} catch {} // node < 19 compatibility

function _sign(secretKey) {
  try {
    const ts = Math.floor(Date.now() / 1000).toString();
    const hmac = _crypto.createHmac('sha256', String(secretKey));
    hmac.update(ts + '\n' + String(secretKey));
    return { timestamp: ts, sign: hmac.digest('base64') };
  } catch {
    return null;
  }
}

// ── card builder ──────────────────────────────────────────────────────

function _buildCard({ title, content, agentName, workspace, urgent, decisionId }) {
  const displayTitle = urgent ? '\u{1F534} ' + title : '\u{1F4CB} ' + title;
  const elements = [];

  if (content && content.trim()) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: String(content).slice(0, 3000) } });
  }
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [{
      tag: 'plain_text',
      content: 'Agent: ' + (agentName || 'unknown') + '  ·  Workspace: ' + (workspace || '-') + '  ·  ID: ' + decisionId,
    }],
  });

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: displayTitle },
        template: urgent ? 'red' : 'blue',
      },
      elements,
    },
  };
}

// ── load config synchronously ─────────────────────────────────────────

function loadConfigSync() {
  try {
    const path = require('node:path');
    const { DATA_DIR } = require('./config');
    const raw = require('node:fs').readFileSync(path.join(DATA_DIR, 'config.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── send ──────────────────────────────────────────────────────────────

function sendFeishuCard({ webhookUrl, title, content, agentName, workspace, urgent, decisionId }) {
  if (!webhookUrl) return;
  const card = _buildCard({ title, content, agentName, workspace, urgent, decisionId });
  const body = JSON.stringify(card);

  let targetUrl;
  try {
    targetUrl = new (require('node:url').URL)(webhookUrl);
  } catch {
    console.warn('[feishu] invalid webhook URL');
    return;
  }

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };

  let finalUrl = webhookUrl;
  try {
    const config = loadConfigSync();
    if (config && config.feishu && config.feishu.secretKey && _crypto) {
      const sig = _sign(config.feishu.secretKey);
      if (sig) {
        finalUrl += (targetUrl.search ? '&' : '?') + 'timestamp=' + sig.timestamp + '&sign=' + encodeURIComponent(sig.sign);
      }
    }
  } catch {}

  const u = new (require('node:url').URL)(finalUrl);
  const req = https.request({
    hostname: u.hostname,
    path: u.pathname + u.search,
    method: 'POST',
    headers,
    timeout: 5000,
  }, function(res) {
    if (res.statusCode >= 400) console.warn('[feishu] webhook returned ' + res.statusCode);
    res.resume();
  });
  req.on('error', function(e) { console.warn('[feishu] webhook failed: ' + e.message); });
  req.on('timeout', function() {
    req.destroy();
    console.warn('[feishu] webhook timed out after 5s');
  });
  req.write(body);
  req.end();
}

// Shorthand that reads webhookUrl from config.
async function sendFeishuCardFromConfig({ title, content, agentName, workspace, urgent, decisionId }) {
  const config = loadConfigSync();
  const webhookUrl = config && config.feishu && config.feishu.webhookUrl;
  if (!webhookUrl) return;
  sendFeishuCard({ webhookUrl, title, content, agentName, workspace, urgent, decisionId });
}

module.exports = { sendFeishuCard, sendFeishuCardFromConfig };
