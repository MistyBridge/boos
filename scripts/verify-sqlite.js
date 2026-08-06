// SQLite availability verification — Sprint 42
// Persistence / concurrency / degradation / JSON sync.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sqlite = require('../lib/sqliteStore');
const adapter = require('../lib/identityAdapter');

(async () => {
  sqlite.dropDatabase();

  // ① Persistence + re-open (restart simulation)
  await adapter.upsert('persist-1', { name: 'PersistAgent', workspace: 'boos', mcp_session_id: 'mcp-persist' });
  sqlite.getPool().close();
  const r = await adapter.resolve('persist-1');
  console.log('① 重启保留:', r && r.name === 'PersistAgent' ? 'OK' : 'FAIL',
    '| db 文件:', fs.existsSync(sqlite.DB_PATH) ? '存在' : '缺失');

  // ② Concurrent writes (10 distinct + 5 same-uid contention)
  const tasks = [];
  for (let i = 0; i < 10; i++) tasks.push(adapter.upsert('conc-' + i, { name: 'Conc' + i, workspace: 'boos' }));
  for (let i = 0; i < 5; i++) tasks.push(adapter.upsert('persist-1', { name: 'PersistAgent', workspace: 'boos', capabilities: ['x'] }));
  await Promise.all(tasks);
  const cnt = sqlite.getDb().prepare('SELECT COUNT(*) c FROM identity_index').get();
  console.log('② 并发 15 写:', cnt.c, '行 |', cnt.c === 11 ? 'OK (10+1 无重复)' : '检查');

  // ③ Degradation: without --experimental-sqlite, getPool() must be null
  const probeScript = `
    const s = require(${JSON.stringify(path.join(process.cwd(), 'lib', 'sqliteStore'))});
    console.log('no-flag pool:', s.getPool());
  `;
  const noFlag = spawnSync(process.execPath, ['-e', probeScript], { encoding: 'utf-8' });
  const degrades = noFlag.stdout.includes('no-flag pool: null');
  console.log('③ 无 flag 降级:', degrades ? 'OK (null → JSON fallback)' : 'FAIL: ' + noFlag.stdout);

  // ④ syncFromJson: full sync from real agent-bus.json
  const synced = await adapter.syncFromJson();
  const total = sqlite.getDb().prepare('SELECT COUNT(*) c FROM identity_index').get().c;
  console.log('④ syncFromJson:', synced, '条同步 | 库内总数:', total);

  sqlite.dropDatabase();
  console.log('AVAILABILITY CHECKS DONE');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
