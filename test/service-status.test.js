import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import {
  attachServiceStatuses,
  getServiceStatusHistory,
  getServiceStatuses,
  handleLegacyNsmcStatusUpdate,
  handleServiceStatusUpdate
} from '../src/handlers/serviceStatus.js';

function createMiniflare() {
  return new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'service-status-test' }
  });
}

async function createTables(db) {
  await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
  await db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY)').run();
  await db.prepare(`
    CREATE TABLE service_status_history (
      server_id TEXT NOT NULL,
      service TEXT NOT NULL,
      state TEXT NOT NULL,
      checked_at INTEGER NOT NULL,
      message TEXT DEFAULT '',
      PRIMARY KEY (server_id, service, checked_at)
    )
  `).run();
  await db.prepare("INSERT INTO servers (id) VALUES ('hpc-c2ln1')").run();
}

test('generic service status stores a compact non-sensitive status record', async () => {
  const miniflare = createMiniflare();
  try {
    const db = await miniflare.getD1Database('DB');
    await createTables(db);
    const checkedAt = Date.now();
    const request = new Request('https://monitor.example/update/service-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'hpc-c2ln1',
        secret: 'monitor-secret',
        service: 'nsmc',
        label: 'NSMC DataPortal',
        state: 'operational',
        checked_at: checkedAt,
        message: 'Session valid'
      })
    });

    const response = await handleServiceStatusUpdate(request, {
      DB: db,
      API_SECRET: 'monitor-secret'
    });
    assert.equal(response.status, 200);

    const statuses = await getServiceStatuses(db, 'hpc-c2ln1');
    assert.deepEqual(statuses, [{
      id: 'hpc-c2ln1',
      service: 'nsmc',
      label: 'NSMC DataPortal',
      state: 'operational',
      checked_at: checkedAt,
      message: 'Session valid'
    }]);

    const servers = [{ id: 'hpc-c2ln1', name: 'Northern HPC' }];
    await attachServiceStatuses(db, servers);
    assert.equal(servers[0].service_statuses.length, 1);
    assert.equal(servers[0].service_statuses[0].service, 'nsmc');

    const row = await db.prepare("SELECT value FROM settings WHERE key = 'service_status:hpc-c2ln1:nsmc'").first();
    assert.equal(row.value.includes('monitor-secret'), false);

    const history = await getServiceStatusHistory(db, 'hpc-c2ln1', 24);
    assert.deepEqual(history.get('nsmc'), [{
      state: 'operational',
      checked_at: checkedAt
    }]);
  } finally {
    await miniflare.dispose();
  }
});

test('legacy NSMC update maps into the generic service model', async () => {
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
        state: 'valid',
        checked_at: checkedAt
      })
    });

    const response = await handleLegacyNsmcStatusUpdate(request, {
      DB: db,
      API_SECRET: 'monitor-secret'
    });
    assert.equal(response.status, 200);
    const statuses = await getServiceStatuses(db, 'hpc-c2ln1');
    assert.equal(statuses[0].state, 'operational');
    assert.equal(statuses[0].label, 'NSMC DataPortal');
    const history = await getServiceStatusHistory(db, 'hpc-c2ln1', 24);
    assert.equal(history.get('nsmc').length, 1);
  } finally {
    await miniflare.dispose();
  }
});

test('service status history supports incremental reads', async () => {
  const miniflare = createMiniflare();
  try {
    const db = await miniflare.getD1Database('DB');
    await createTables(db);
    const firstCheckedAt = Date.now() - 60_000;
    const secondCheckedAt = Date.now();

    for (const checkedAt of [firstCheckedAt, secondCheckedAt]) {
      const request = new Request('https://monitor.example/update/service-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'hpc-c2ln1',
          secret: 'monitor-secret',
          service: 'nsmc',
          label: 'NSMC DataPortal',
          state: 'operational',
          checked_at: checkedAt,
          message: 'Session valid'
        })
      });
      const response = await handleServiceStatusUpdate(request, {
        DB: db,
        API_SECRET: 'monitor-secret'
      });
      assert.equal(response.status, 200);
    }

    const fullHistory = await getServiceStatusHistory(db, 'hpc-c2ln1', 24);
    assert.equal(fullHistory.get('nsmc').length, 2);

    const incremental = await getServiceStatusHistory(db, 'hpc-c2ln1', 24, firstCheckedAt);
    assert.deepEqual(incremental.get('nsmc'), [{
      state: 'operational',
      checked_at: secondCheckedAt
    }]);
  } finally {
    await miniflare.dispose();
  }
});

test('generic service status rejects an invalid monitor secret', async () => {
  const miniflare = createMiniflare();
  try {
    const db = await miniflare.getD1Database('DB');
    await createTables(db);
    const request = new Request('https://monitor.example/update/service-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'hpc-c2ln1',
        secret: 'wrong',
        service: 'nsmc',
        label: 'NSMC DataPortal',
        state: 'operational',
        checked_at: Date.now()
      })
    });

    const response = await handleServiceStatusUpdate(request, {
      DB: db,
      API_SECRET: 'monitor-secret'
    });
    assert.equal(response.status, 401);
    const row = await db.prepare("SELECT value FROM settings WHERE key LIKE 'service_status:%'").first();
    assert.equal(row, null);
  } finally {
    await miniflare.dispose();
  }
});
