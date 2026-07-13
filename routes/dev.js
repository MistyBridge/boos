// Dev-mode routes — only active when running from a checkout.

'use strict';

const path = require('node:path');
const fs = require('node:fs');

function register(app, { reloadClients, publicDir }) {
  app.get('/api/dev/ping', (_req, res) => res.json({ dev: true }));

  app.get('/api/dev/reload', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(': connected\n\n');
    reloadClients.add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(hb); reloadClients.delete(res); });
  });

  let debounce = null;
  fs.watch(publicDir, { recursive: true }, (_event, filename) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (reloadClients.size === 0) return;
      console.log('[dev] reload · ' + (filename || '?') + ' → ' + reloadClients.size + ' client(s)');
      for (const r of reloadClients) {
        try { r.write('event: reload\ndata: ' + Date.now() + '\n\n'); } catch {}
      }
    }, 80);
  });
  console.log('[dev] hot-reload watching public/');
}

module.exports = { register };
