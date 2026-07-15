// Knowledge Base REST API — browse and update shared agent knowledge.
//
// register(app, deps)
//   deps: { asyncH }

'use strict';

const kb = require('../lib/knowledgeBase');

function register(app, { asyncH }) {
  // GET /api/knowledge/:section/:file...? — read entry or list section
  app.get('/api/knowledge/*', asyncH(async (req, res) => {
    const p = req.params[0] || '';
    const r = kb.readEntry(p);
    res.json(r);
  }));

  // PUT /api/knowledge/:path — create or update entry
  app.put('/api/knowledge/*', asyncH(async (req, res) => {
    const p = req.params[0] || '';
    const { content, append, author } = req.body || {};
    if (!content) return res.status(400).json({ ok: false, error: 'content required' });
    const r = kb.writeEntry(p, content, { append, author });
    res.json(r);
  }));

  // GET /api/knowledge?q=<query> — search knowledge base
  app.get('/api/knowledge', asyncH(async (req, res) => {
    if (req.query.q) {
      const r = kb.search(req.query.q);
      return res.json(r);
    }
    // No query → list root.
    const r = kb.listSection(null);
    res.json(r);
  }));
}

module.exports = { register };
