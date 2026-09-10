import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { getAllServers, getCacheDuration } from '../utils/cache.js';
import {
  createBadRequestResponse,
  createNotFoundResponse,
  createSuccessResponse,
  createUnauthorizedResponse
} from '../utils/errors.js';

const STATUS_PREFIX = 'service_status:';
const LEGACY_NSMC_PREFIX = 'nsmc_status:';
const ALLOWED_STATES = new Set([
  'operational',
  'degraded',
  'unavailable',
  'maintenance',
  'auth_required',
  'error'
]);
const MAX_SERVER_ID_LENGTH = 128;
const MAX_SERVICE_ID_LENGTH = 64;
const MAX_LABEL_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 240;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_STATUS_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_HISTORY_HOURS = 24;
const MAX_HISTORY_HOURS = 30 * 24;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_INCREMENTAL_SAMPLES = 2048;
const historySchemaReady = new WeakSet();
const serviceStatusHistoryCaches = new WeakMap();

async function ensureServiceStatusHistorySchema(db) {
  if (historySchemaReady.has(db)) return;
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS service_status_history (
      server_id TEXT NOT NULL,
      service TEXT NOT NULL,
      state TEXT NOT NULL,
      checked_at INTEGER NOT NULL,
      message TEXT DEFAULT '',
      PRIMARY KEY (server_id, service, checked_at)
    )
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_service_status_history_server_time
    ON service_status_history (server_id, checked_at)
  `).run();
  historySchemaReady.add(db);
}

function serviceStatusHistoryCacheKey(serverId, hours) {
  return `${serverId}:${hours}`;
}

function getServiceStatusHistoryCache(db) {
  let cache = serviceStatusHistoryCaches.get(db);
  if (!cache) {
    cache = new Map();
    serviceStatusHistoryCaches.set(db, cache);
  }
  return cache;
}

function clearServiceStatusHistoryCache(db, serverId = null) {
  const cache = getServiceStatusHistoryCache(db);
  if (!serverId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${serverId}:`)) cache.delete(key);
  }
}

function normalizeTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 10000000000 ? number * 1000 : number;
}

function normalizeServiceId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-z._-]/g, '')
    .slice(0, MAX_SERVICE_ID_LENGTH);
}

function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function settingKey(serverId, serviceId) {
  return `${STATUS_PREFIX}${serverId}:${serviceId}`;
}

function parseGenericStatus(row) {
  if (!row?.key || !row?.value || !String(row.key).startsWith(STATUS_PREFIX)) return null;
  try {
    const suffix = String(row.key).slice(STATUS_PREFIX.length);
    const separator = suffix.lastIndexOf(':');
    if (separator <= 0 || separator === suffix.length - 1) return null;
    const id = suffix.slice(0, separator);
    const service = normalizeServiceId(suffix.slice(separator + 1));
    const parsed = JSON.parse(row.value);
    const checkedAt = normalizeTimestamp(parsed?.checked_at);
    if (!id || !service || !checkedAt || !ALLOWED_STATES.has(parsed?.state)) return null;
    return {
      id,
      service,
      label: normalizeText(parsed.label, MAX_LABEL_LENGTH) || service,
      state: parsed.state,
      checked_at: checkedAt,
      message: normalizeText(parsed.message, MAX_MESSAGE_LENGTH)
    };
  } catch (_) {
    return null;
  }
}

function parseLegacyNsmcStatus(row) {
  if (!row?.key || !row?.value || !String(row.key).startsWith(LEGACY_NSMC_PREFIX)) return null;
  try {
    const id = String(row.key).slice(LEGACY_NSMC_PREFIX.length);
    const parsed = JSON.parse(row.value);
    const checkedAt = normalizeTimestamp(parsed?.checked_at);
    if (!id || !checkedAt) return null;
    const state = parsed?.state === 'valid'
      ? 'operational'
      : parsed?.state === 'auth_required'
        ? 'auth_required'
        : 'error';
    return {
      id,
      service: 'nsmc',
      label: 'NSMC DataPortal',
      state,
      checked_at: checkedAt,
      message: state === 'operational'
        ? 'Session valid'
        : state === 'auth_required'
          ? 'Login required'
          : 'Session check failed'
    };
  } catch (_) {
    return null;
  }
}

export async function getServiceStatuses(db, serverId = null) {
  const genericPrefix = serverId
    ? `${STATUS_PREFIX}${serverId}:`
    : STATUS_PREFIX;
  const legacyPrefix = serverId
    ? `${LEGACY_NSMC_PREFIX}${serverId}`
    : LEGACY_NSMC_PREFIX;
  const result = serverId
    ? await db.prepare(
      'SELECT key, value FROM settings WHERE instr(key, ?) = 1 OR key = ?'
    ).bind(genericPrefix, legacyPrefix).all()
    : await db.prepare(
      'SELECT key, value FROM settings WHERE instr(key, ?) = 1 OR instr(key, ?) = 1'
    ).bind(genericPrefix, legacyPrefix).all();

  const statuses = new Map();
  for (const row of result?.results || []) {
    const legacy = parseLegacyNsmcStatus(row);
    if (legacy) statuses.set(`${legacy.id}\u0000${legacy.service}`, legacy);
  }
  for (const row of result?.results || []) {
    const status = parseGenericStatus(row);
    if (status) statuses.set(`${status.id}\u0000${status.service}`, status);
  }
  return [...statuses.values()].sort((a, b) => (
    a.id.localeCompare(b.id) || a.label.localeCompare(b.label) || a.service.localeCompare(b.service)
  ));
}

export async function getServiceStatusHistory(
  db,
  serverId,
  hours = DEFAULT_HISTORY_HOURS,
  since = null
) {
  await ensureServiceStatusHistorySchema(db);
  const safeHours = Math.max(1, Math.min(MAX_HISTORY_HOURS, Number(hours) || DEFAULT_HISTORY_HOURS));
  const normalizedSince = normalizeTimestamp(since);
  let result;

  if (normalizedSince) {
    result = await db.prepare(`
      SELECT service, state, checked_at
      FROM service_status_history
      WHERE server_id = ? AND checked_at > ?
      ORDER BY checked_at ASC
      LIMIT ?
    `).bind(serverId, normalizedSince, MAX_INCREMENTAL_SAMPLES).all();
  } else {
    const cacheKey = serviceStatusHistoryCacheKey(serverId, safeHours);
    const historyCache = getServiceStatusHistoryCache(db);
    const cached = historyCache.get(cacheKey);
    const cacheDuration = getCacheDuration(safeHours);
    if (cached && Date.now() - cached.timestamp < cacheDuration) {
      return cached.data;
    }

    const cutoff = Date.now() - safeHours * 60 * 60 * 1000;
    result = await db.prepare(`
      SELECT service, state, checked_at
      FROM service_status_history
      WHERE server_id = ? AND checked_at >= ?
      ORDER BY checked_at ASC
    `).bind(serverId, cutoff).all();
  }

  const byService = new Map();
  for (const row of result?.results || []) {
    const service = normalizeServiceId(row?.service);
    const state = String(row?.state || '').trim().toLowerCase();
    const checkedAt = normalizeTimestamp(row?.checked_at);
    if (!service || !ALLOWED_STATES.has(state) || !checkedAt) continue;
    const samples = byService.get(service) || [];
    samples.push({ state, checked_at: checkedAt });
    byService.set(service, samples);
  }
  if (!normalizedSince) {
    getServiceStatusHistoryCache(db).set(serviceStatusHistoryCacheKey(serverId, safeHours), {
      data: byService,
      timestamp: Date.now()
    });
  }
  return byService;
}

export async function cleanupServiceStatusHistory(db, now = Date.now()) {
  await ensureServiceStatusHistorySchema(db);
  const result = await db.prepare(`
    DELETE FROM service_status_history
    WHERE checked_at < ?
  `).bind(now - HISTORY_RETENTION_MS).run();
  clearServiceStatusHistoryCache(db);
  return result;
}

export async function attachServiceStatuses(db, servers) {
  if (!Array.isArray(servers) || servers.length === 0) return servers;
  const allStatuses = await getServiceStatuses(db);
  const byServer = new Map();
  for (const status of allStatuses) {
    const list = byServer.get(status.id) || [];
    list.push(status);
    byServer.set(status.id, list);
  }
  for (const server of servers) {
    const statuses = byServer.get(String(server?.id || ''));
    if (statuses?.length) server.service_statuses = statuses;
  }
  return servers;
}

async function storeServiceStatus(env, data) {
  const id = String(data?.id || '').trim();
  if (!id || id.length > MAX_SERVER_ID_LENGTH) {
    return createBadRequestResponse('Invalid server ID');
  }

  const service = normalizeServiceId(data?.service);
  if (!service) return createBadRequestResponse('Invalid service ID');

  const state = String(data?.state || '').trim().toLowerCase();
  if (!ALLOWED_STATES.has(state)) {
    return createBadRequestResponse('Invalid service state');
  }

  const checkedAt = normalizeTimestamp(data?.checked_at);
  const now = Date.now();
  if (
    !checkedAt ||
    checkedAt > now + MAX_CLOCK_SKEW_MS ||
    checkedAt < now - MAX_STATUS_AGE_MS
  ) {
    return createBadRequestResponse('Invalid checked_at');
  }

  const server = await env.DB.prepare('SELECT id FROM servers WHERE id = ?').bind(id).first();
  if (!server) return createNotFoundResponse('Server not found');

  await ensureServiceStatusHistorySchema(env.DB);

  const value = JSON.stringify({
    label: normalizeText(data?.label, MAX_LABEL_LENGTH) || service,
    state,
    checked_at: checkedAt,
    message: normalizeText(data?.message, MAX_MESSAGE_LENGTH),
    updated_at: now
  });
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).bind(settingKey(id, service), value),
    env.DB.prepare(`
      INSERT OR IGNORE INTO service_status_history
        (server_id, service, state, checked_at, message)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      id,
      service,
      state,
      checkedAt,
      normalizeText(data?.message, MAX_MESSAGE_LENGTH)
    )
  ]);
  clearServiceStatusHistoryCache(env.DB, id);

  return createSuccessResponse({ ok: true });
}

export async function handleServiceStatusUpdate(request, env) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > 4096) return createBadRequestResponse('Payload too large');

  let data;
  try {
    data = await request.json();
  } catch (_) {
    return createBadRequestResponse('Invalid JSON');
  }

  if (data?.secret !== env.API_SECRET) {
    return createUnauthorizedResponse('Invalid secret');
  }
  return storeServiceStatus(env, data);
}

export async function handleLegacyNsmcStatusUpdate(request, env) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > 4096) return createBadRequestResponse('Payload too large');

  let data;
  try {
    data = await request.json();
  } catch (_) {
    return createBadRequestResponse('Invalid JSON');
  }
  if (data?.secret !== env.API_SECRET) {
    return createUnauthorizedResponse('Invalid secret');
  }
  const state = data?.state === 'valid'
    ? 'operational'
    : data?.state === 'auth_required'
      ? 'auth_required'
      : 'error';
  return storeServiceStatus(env, {
    id: data?.id,
    service: 'nsmc',
    label: 'NSMC DataPortal',
    state,
    checked_at: data?.checked_at,
    message: state === 'operational'
      ? 'Session valid'
      : state === 'auth_required'
        ? 'Login required'
        : 'Session check failed'
  });
}

export async function handleServiceStatusAPI(request, env, sys) {
  const isLoggedIn = await checkAuth(request, env, sys);
  if (sys.is_public !== 'true' && !isLoggedIn) return simpleAuthResponse();

  const url = new URL(request.url);
  const requestedId = String(url.searchParams.get('id') || '').trim();
  const requestedHours = Math.max(
    1,
    Math.min(MAX_HISTORY_HOURS, Number(url.searchParams.get('hours')) || DEFAULT_HISTORY_HOURS)
  );
  const requestedSince = normalizeTimestamp(url.searchParams.get('since'));
  const includeHistory = url.searchParams.get('history') !== '0';
  const servers = await getAllServers(env.DB, isLoggedIn);
  const visibleIds = new Set((servers || []).map(server => String(server.id)));
  if (requestedId && !visibleIds.has(requestedId)) {
    return createNotFoundResponse('Server not found');
  }

  const services = await getServiceStatuses(env.DB, requestedId || null);
  const historyByService = requestedId && includeHistory
    ? await getServiceStatusHistory(env.DB, requestedId, requestedHours, requestedSince)
    : new Map();
  return createSuccessResponse({
    hours: requestedHours,
    since: requestedSince || null,
    services: services
      .filter(status => visibleIds.has(status.id))
      .map(status => ({
        ...status,
        history: requestedId && includeHistory ? (historyByService.get(status.service) || []) : []
      }))
  });
}
