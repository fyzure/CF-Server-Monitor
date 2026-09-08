import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import {
  attachNsmcStatuses,
  getNsmcStatusMap,
  handleNsmcStatusUpdate
} from '../src/handlers/nsmcStatus.js';

function createMiniflare() {
  return new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'nsmc-status-test' }
  });
}

async function createTables(db) {
  await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
  await db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY)').run();
  await db.prepare("INSERT INTO servers (id) VALUES ('hpc-c2ln1')").run();
}

test('NSMC status update stores only non-sensitive card state', async () => {
  const miniflare = createMiniflare();
  try {
    const db = await miniflare.getD1Database('DB');
    await createTables(db);
    const checkedAt = Date.now();
    const request = new Request('https://monitor.example/update/nsmc-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'hpc-c2ln1',
        secret: 'monitor-secret',
        account: 'feng-main',
        state: 'valid',
        checked_at: checkedAt
      })
    });

    const response = await handleNsmcStatusUpdate(request, {
      DB: db,
      API_SECRET: 'monitor-secret'
    });
    assert.equal(response.status, 200);

    const statuses = await getNsmcStatusMap(db);
    assert.deepEqual(statuses.get('hpc-c2ln1'), {
      id: 'hpc-c2ln1',
      state: 'valid',
      checked_at: checkedAt,
      account: 'feng-main'
    });

    const servers = [{ id: 'hpc-c2ln1', name: 'Northern HPC' }];
    await attachNsmcStatuses(db, servers);
    assert.equal(servers[0].nsmc_session_state, 'valid');
    assert.equal(servers[0].nsmc_session_checked_at, checkedAt);
    assert.equal(servers[0].nsmc_session_account, 'feng-main');

    const row = await db.prepare("SELECT value FROM settings WHERE key = 'nsmc_status:hpc-c2ln1'").first();
    assert.equal(row.value.includes('monitor-secret'), false);
  } finally {
    await miniflare.dispose();
  }
});

test('NSMC status update rejects an invalid monitor secret', async () => {
  const miniflare = createMiniflare();
  try {
    const db = await miniflare.getD1Database('DB');
    await createTables(db);
    const request = new Request('https://monitor.example/update/nsmc-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'hpc-c2ln1',
        secret: 'wrong',
        account: 'feng-main',
        state: 'valid',
        checked_at: Date.now()
      })
    });

    const response = await handleNsmcStatusUpdate(request, {
      DB: db,
      API_SECRET: 'monitor-secret'
    });
    assert.equal(response.status, 401);
    const row = await db.prepare("SELECT value FROM settings WHERE key LIKE 'nsmc_status:%'").first();
    assert.equal(row, null);
  } finally {
    await miniflare.dispose();
  }
});
