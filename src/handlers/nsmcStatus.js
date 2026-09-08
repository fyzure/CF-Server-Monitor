import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { getAllServers } from '../utils/cache.js';
import {
  createBadRequestResponse,
  createNotFoundResponse,
  createSuccessResponse,
  createUnauthorizedResponse
} from '../utils/errors.js';

const STATUS_PREFIX = 'nsmc_status:';
const ALLOWED_STATES = new Set(['valid', 'auth_required', 'error']);
const MAX_ACCOUNT_LENGTH = 64;
const MAX_SERVER_ID_LENGTH = 128;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_STATUS_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 10000000000 ? number * 1000 : number;
}

function normalizeAccount(value) {
  return String(value || '')
    .trim()
    .replace(/[^0-9A-Za-z._-]/g, '')
    .slice(0, MAX_ACCOUNT_LENGTH);
}

function settingKey(serverId) {
  return `${STATUS_PREFIX}${serverId}`;
}

function parseStoredStatus(row) {
  if (!row?.key || !row?.value || !String(row.key).startsWith(STATUS_PREFIX)) return null;
  try {
    const parsed = JSON.parse(row.value);
    const serverId = String(row.key).slice(STATUS_PREFIX.length);
    if (!serverId || !ALLOWED_STATES.has(parsed?.state)) return null;
    const checkedAt = normalizeTimestamp(parsed.checked_at);
    if (!checkedAt) return null;
    return {
      id: serverId,
      state: parsed.state,
      checked_at: checkedAt,
      account: normalizeAccount(parsed.account)
    };
  } catch (_) {
    return null;
  }
}

export async function getNsmcStatusMap(db) {
  const result = await db.prepare(
    'SELECT key, value FROM settings WHERE key LIKE ?'
  ).bind(`${STATUS_PREFIX}%`).all();
  const statuses = new Map();
  for (const row of result?.results || []) {
    const status = parseStoredStatus(row);
    if (status) statuses.set(status.id, status);
  }
  return statuses;
}

export async function attachNsmcStatuses(db, servers) {
  if (!Array.isArray(servers) || servers.length === 0) return servers;
  const statuses = await getNsmcStatusMap(db);
  for (const server of servers) {
    const status = statuses.get(String(server?.id || ''));
    if (!status) continue;
    server.nsmc_session_state = status.state;
    server.nsmc_session_checked_at = status.checked_at;
    server.nsmc_session_account = status.account;
  }
  return servers;
}

export async function handleNsmcStatusUpdate(request, env) {
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

  const id = String(data?.id || '').trim();
  if (!id || id.length > MAX_SERVER_ID_LENGTH) {
    return createBadRequestResponse('Invalid server ID');
  }

  const state = String(data?.state || '').trim().toLowerCase();
  if (!ALLOWED_STATES.has(state)) {
    return createBadRequestResponse('Invalid NSMC state');
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

  const value = JSON.stringify({
    state,
    checked_at: checkedAt,
    account: normalizeAccount(data?.account),
    updated_at: now
  });
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(settingKey(id), value).run();

  return createSuccessResponse({ ok: true });
}

export async function handleNsmcStatusAPI(request, env, sys) {
  const isLoggedIn = await checkAuth(request, env, sys);
  if (sys.is_public !== 'true' && !isLoggedIn) return simpleAuthResponse();

  const servers = await getAllServers(env.DB, isLoggedIn);
  const statuses = await getNsmcStatusMap(env.DB);
  const visibleIds = new Set((servers || []).map(server => String(server.id)));
  const result = [];
  for (const [id, status] of statuses) {
    if (!visibleIds.has(id)) continue;
    result.push(status);
  }
  return createSuccessResponse({ statuses: result });
}
