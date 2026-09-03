import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { getDashboardLatencyHistory } from '../src/database/schema.js';
import { buildHistoryId } from '../src/database/indexOptimization.js';
import {
  appendLatestLatencySample,
  getLatestRealtimeSamplesByServer,
  getLatestRealtimeReportTimestamps
} from '../src/handlers/dashboard.js';
import {
  DASHBOARD_LATENCY_WINDOW_HOURS,
  DASHBOARD_LATENCY_WINDOW_POINTS
} from '../src/utils/config.js';

function createMiniflare() {
  return new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'dashboard-latency-window-test' }
  });
}

async function createHistoryTable(db) {
  await db.prepare(`
    CREATE TABLE metrics_history (
      id INTEGER PRIMARY KEY,
      timestamp INTEGER,
      ping_ct INTEGER,
      ping_cu INTEGER,
      ping_cm INTEGER,
      ping_bd INTEGER,
      loss_ct INTEGER,
      loss_cu INTEGER,
      loss_cm INTEGER,
      loss_bd INTEGER
    )
  `).run();
}

function latencyRow(partitionId, timestamp, value) {
  return `(${buildHistoryId(partitionId, timestamp)}, ${timestamp}, ${value}, ${value + 1}, ${value + 2}, ${value + 3}, ${value % 10}, ${(value + 1) % 10}, ${(value + 2) % 10}, ${(value + 3) % 10})`;
}

test('dashboard latency history samples one hour from D1 into at most 20 real points', async () => {
  const miniflare = createMiniflare();

  try {
    const db = await miniflare.getD1Database('DB');
    await createHistoryTable(db);

    const partitionId = 1;
    const start = Date.UTC(2026, 6, 29, 0, 0, 0);
    const rows = [];
    for (let index = 0; index < 120; index++) {
      rows.push(latencyRow(partitionId, start + index * 60_000, 20 + index));
    }

    await db.prepare(`
      INSERT INTO metrics_history (
        id, timestamp,
        ping_ct, ping_cu, ping_cm, ping_bd,
        loss_ct, loss_cu, loss_cm, loss_bd
      )
      VALUES ${rows.join(',')}
    `).run();

    const history = await getDashboardLatencyHistory(db, [{
      id: 'server-1',
      history_partition_id: partitionId,
      timestamp: start
    }], {
      now: start + 120 * 60_000,
      cache: false
    });

    const window = history.get('server-1');
    assert.equal(window.ping.length, 20);
    assert.equal(window.loss.length, 20);
    assert.equal(new Set(window.ping.map(point => point.ts)).size, 20);
    assert.equal(window.ping.every(point => point.ct >= 20), true);
    assert.equal(window.loss.every(point => point.ct >= 0 && point.ct <= 100), true);
  } finally {
    await miniflare.dispose();
  }
});

test('dashboard latency window config exposes the public contract', () => {
  assert.equal(DASHBOARD_LATENCY_WINDOW_POINTS, 20);
  assert.equal(DASHBOARD_LATENCY_WINDOW_HOURS, 1);
});

test('dashboard prefers the freshest realtime report timestamp for online presence', () => {
  const timestamps = getLatestRealtimeReportTimestamps([
    { serverId: 'server-a', reportTs: 1_788_442_600 },
    { serverId: 'server-a', reportTs: 1_788_442_605_000 },
    { serverId: 'server-b', report_timestamp: 1_788_442_603_000 },
    { serverId: '', reportTs: 1_788_442_604_000 },
    { serverId: 'server-c', reportTs: 'invalid' }
  ]);

  assert.equal(timestamps.get('server-a'), 1_788_442_605_000);
  assert.equal(timestamps.get('server-b'), 1_788_442_603_000);
  assert.equal(timestamps.has('server-c'), false);
});

test('dashboard exposes the freshest realtime sample so legacy themes receive a fresh last_updated', () => {
  const samples = getLatestRealtimeSamplesByServer([
    {
      serverId: 'server-a',
      samples: [
        { ts: 1_788_442_600, data: { cpu: 12 } },
        { ts: 1_788_442_605_000, data: { cpu: 18, net_in_speed: 1024 } }
      ]
    },
    {
      serverId: 'server-b',
      samples: [{ timestamp: 1_788_442_603_000, data: { cpu: 7 } }]
    }
  ]);

  assert.deepEqual(samples.get('server-a'), {
    ts: 1_788_442_605_000,
    data: { cpu: 18, net_in_speed: 1024 }
  });
  assert.deepEqual(samples.get('server-b'), {
    ts: 1_788_442_603_000,
    data: { cpu: 7 }
  });
});

test('dashboard latency window appends the latest sample while keeping at most 20 points', () => {
  const base = Date.UTC(2026, 7, 31, 12, 0, 0);
  const server = {
    ping: Array.from({ length: 20 }, (_, index) => ({
      ts: base + index * 180_000,
      ct: 100 + index,
      cu: 110 + index,
      cm: 120 + index
    })),
    loss: Array.from({ length: 20 }, (_, index) => ({
      ts: base + index * 180_000,
      ct: 0,
      cu: 0,
      cm: 0
    })),
    ping_ct: 155,
    ping_cu: 166,
    ping_cm: 177,
    ping_bd: false,
    loss_ct: 0,
    loss_cu: 1,
    loss_cm: 2,
    loss_bd: false
  };

  const latestTs = base + 60 * 60_000;
  appendLatestLatencySample(server, latestTs);

  assert.equal(server.ping.length, 20);
  assert.equal(server.loss.length, 20);
  assert.equal(server.ping[0].ts, base + 180_000);
  assert.deepEqual(server.ping.at(-1), {
    ts: latestTs,
    ct: 155,
    cu: 166,
    cm: 177,
    bd: false
  });
  assert.deepEqual(server.loss.at(-1), {
    ts: latestTs,
    ct: 0,
    cu: 1,
    cm: 2,
    bd: false
  });
});

test('dashboard latency history preserves empty buckets inside the window', async () => {
  const miniflare = createMiniflare();

  try {
    const db = await miniflare.getD1Database('DB');
    await createHistoryTable(db);

    const partitionId = 3;
    const now = Date.UTC(2026, 6, 29, 4, 0, 0);
    const queryStart = now - DASHBOARD_LATENCY_WINDOW_HOURS * 60 * 60 * 1000;
    const queryEnd = Math.floor(now / 1000) * 1000 + 1000;
    const intervalMs = Math.max(10_000, Math.ceil((queryEnd - queryStart) / DASHBOARD_LATENCY_WINDOW_POINTS));
    const slotTimestamp = index => queryStart + index * intervalMs + 1000;

    await db.prepare(`
      INSERT INTO metrics_history (
        id, timestamp,
        ping_ct, ping_cu, ping_cm, ping_bd,
        loss_ct, loss_cu, loss_cm, loss_bd
      )
      VALUES
        ${latencyRow(partitionId, slotTimestamp(0), 20)},
        ${latencyRow(partitionId, slotTimestamp(5), 50)},
        ${latencyRow(partitionId, slotTimestamp(19), 90)}
    `).run();

    const history = await getDashboardLatencyHistory(db, [{
      id: 'server-gap',
      history_partition_id: partitionId,
      timestamp: queryStart
    }], {
      now,
      cache: false
    });

    const window = history.get('server-gap');
    assert.equal(window.ping.length, DASHBOARD_LATENCY_WINDOW_POINTS);
    assert.equal(window.loss.length, DASHBOARD_LATENCY_WINDOW_POINTS);
    assert.equal(window.ping[0].ct, 20);
    assert.equal(window.ping[1].ct, undefined);
    assert.equal(window.ping[5].ct, 50);
    assert.equal(window.ping[6].ct, undefined);
    assert.equal(window.ping[19].ct, 90);
    assert.equal(window.loss[1].ct, undefined);
    assert.equal(window.ping[5].ts, queryStart + 5 * intervalMs);
  } finally {
    await miniflare.dispose();
  }
});

test('dashboard latency history cache is reused for two minutes per server', async () => {
  const miniflare = createMiniflare();

  try {
    const db = await miniflare.getD1Database('DB');
    await createHistoryTable(db);

    const partitionId = 2;
    const start = Date.UTC(2026, 6, 29, 1, 0, 0);
    await db.prepare(`
      INSERT INTO metrics_history (
        id, timestamp,
        ping_ct, ping_cu, ping_cm, ping_bd,
        loss_ct, loss_cu, loss_cm, loss_bd
      )
      VALUES ${latencyRow(partitionId, start, 30)}
    `).run();

    const server = {
      id: 'server-cache',
      history_partition_id: partitionId,
      timestamp: start
    };
    const first = await getDashboardLatencyHistory(db, [server], {
      now: start + 60_000
    });
    assert.equal(first.get('server-cache').ping.at(-1).ct, 30);

    await db.prepare(`
      INSERT INTO metrics_history (
        id, timestamp,
        ping_ct, ping_cu, ping_cm, ping_bd,
        loss_ct, loss_cu, loss_cm, loss_bd
      )
      VALUES ${latencyRow(partitionId, start + 60_000, 90)}
    `).run();

    const cached = await getDashboardLatencyHistory(db, [server], {
      now: start + 90_000
    });
    assert.equal(cached.get('server-cache').ping.at(-1).ct, 30);

    const refreshed = await getDashboardLatencyHistory(db, [server], {
      now: start + 3 * 60_000
    });
    assert.equal(refreshed.get('server-cache').ping.at(-1).ct, 90);
  } finally {
    await miniflare.dispose();
  }
});
