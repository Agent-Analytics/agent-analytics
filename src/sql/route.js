/**
 * POST /sql for the self-hosted server.
 *
 * Auth is the read API key. The statement is prepared by the shared SQL
 * contract, including the date window, then executed by the caller. Node
 * passes a read-only SQLite connection. Workers passes the D1 binding, which
 * can write. That difference is documented on the Workers entry point.
 *
 * The route waits at most 10 seconds for executeSql. On Workers that ends
 * the HTTP call only. The D1 statement can still finish after the response.
 */

import {
  ERROR_CODES,
  errorResponse,
  MAX_BODY_BYTES,
  SQL_MAX_BYTES,
  wrapProjectSql,
} from '@agent-analytics/core';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  'Access-Control-Allow-Credentials': 'false',
};

const EXPENSIVE_ROWS_READ = 1_000_000;
const SQL_TIMEOUT_MS = 10_000;

function sqlWindowFromBody(body) {
  const window = {};
  if (Object.hasOwn(body, 'days')) window.days = body.days;
  if (Object.hasOwn(body, 'date_from')) window.date_from = body.date_from;
  if (Object.hasOwn(body, 'date_to')) window.date_to = body.date_to;
  return window;
}

function timeoutError() {
  const error = new Error('sql timed out');
  error.code = 'SQL_TIMEOUT';
  return error;
}

// A late D1 rejection must not surface as an unhandled rejection after the
// route has already returned SQL_TIMEOUT. The statement itself keeps running.
async function executeWithinTimeout(execute) {
  let timer;
  const pending = Promise.resolve().then(execute);
  pending.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), SQL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function clientMessage(error) {
  const message = String(error?.message || 'sql failed').replace(/\s+/g, ' ').trim();
  if (!message) return 'sql failed';
  return message.length > 300 ? `${message.slice(0, 300)}` : message;
}

function isTimeout(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return /timeout|timed out|SQLITE_INTERRUPT|CPU time limit|exceeded the time/i.test(text);
}

function failureResponse(error) {
  if (isTimeout(error) || error?.code === 'SQL_TIMEOUT') {
    return json(errorResponse('SQL_TIMEOUT', 'sql timed out'), 504);
  }

  if (error?.code === 'INVALID_SQL' || error?.code === 'INVALID_WINDOW') {
    const status = Number.isInteger(error.status) ? error.status : 400;
    return json(errorResponse(error.code, clientMessage(error)), status);
  }

  const sqliteCode = String(error?.code || '');
  if (sqliteCode === 'SQLITE_BUSY' || sqliteCode === 'SQLITE_LOCKED') {
    return json(errorResponse('INTERNAL_ERROR', 'database is busy'), 500);
  }
  if (sqliteCode.startsWith('SQLITE_')) {
    return json(errorResponse('INVALID_SQL', clientMessage(error)), 400);
  }

  console.error('SQL route error:', error);
  return json(errorResponse(ERROR_CODES.INTERNAL_ERROR, 'internal error'), 500);
}

export function shapeSqlResult({ columns, rows, elapsed_ms, rows_read, returnLimit = 1000 }) {
  const list = Array.isArray(rows) ? rows : [];
  const cap = Number.isInteger(returnLimit) && returnLimit >= 0 ? returnLimit : 1000;
  const truncated = list.length > cap;
  const kept = truncated ? list.slice(0, cap) : list;
  const read = Number.isFinite(rows_read) ? rows_read : null;

  return {
    columns: Array.isArray(columns) ? columns : [],
    rows: kept,
    count: kept.length,
    truncated,
    statistics: {
      elapsed_ms: Math.max(0, Math.round(Number(elapsed_ms) || 0)),
      rows_read: read,
      expensive: read !== null && read > EXPENSIVE_ROWS_READ,
    },
  };
}

/**
 * Handle POST /sql. Returns a Response.
 *
 * @param {Request} request
 * @param {{ validateRead: Function, executeSql: Function }} options
 */
export async function handleSqlRequest(request, { validateRead, executeSql }) {
  const url = new URL(request.url);
  const auth = validateRead(request, url);
  if (!auth?.valid) {
    return json(errorResponse(ERROR_CODES.AUTH_REQUIRED, 'API key required'), 401);
  }

  let raw = '';
  try {
    raw = await request.text();
  } catch {
    return json(errorResponse(ERROR_CODES.INVALID_BODY, 'invalid json body'), 400);
  }

  if (byteLength(raw) > MAX_BODY_BYTES) {
    return json(errorResponse(ERROR_CODES.INVALID_BODY, 'request body too large'), 413);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(errorResponse(ERROR_CODES.INVALID_BODY, 'invalid json body'), 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(errorResponse(ERROR_CODES.INVALID_BODY, 'invalid json body'), 400);
  }

  if (typeof body.project !== 'string' || body.project.length === 0) {
    return json(errorResponse(ERROR_CODES.PROJECT_REQUIRED, 'project required'), 400);
  }

  if (typeof body.sql !== 'string') {
    return json(errorResponse('INVALID_SQL', 'sql must be a string'), 400);
  }

  // A trailing line comment would swallow a LIMIT appended on the same line.
  // The shared wrapper appends the cap at the end of the statement, so give
  // that LIMIT its own line when the extra byte still fits in the 20 KB cap.
  let statement = body.sql;
  if (!statement.endsWith('\n') && byteLength(statement) + 1 <= SQL_MAX_BYTES) {
    statement = `${statement}\n`;
  }

  let prepared;
  try {
    prepared = wrapProjectSql(statement, body.project, sqlWindowFromBody(body));
  } catch (error) {
    return failureResponse(error);
  }

  try {
    const executed = await executeWithinTimeout(() => executeSql(prepared));
    const shaped = shapeSqlResult({
      ...executed,
      returnLimit: prepared.returnLimit,
    });
    return json({
      columns: shaped.columns,
      rows: shaped.rows,
      count: shaped.count,
      truncated: shaped.truncated,
      window: prepared.window,
      statistics: shaped.statistics,
    });
  } catch (error) {
    return failureResponse(error);
  }
}
