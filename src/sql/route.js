/**
 * POST /sql for the self-hosted server.
 *
 * Auth is the read API key. The statement is prepared by the shared SQL
 * contract, then executed by the caller. Node passes a read-only SQLite
 * connection. Workers passes the D1 binding, which can write. That difference
 * is documented on the Workers entry point.
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

  if (error?.code === 'INVALID_SQL') {
    return json(errorResponse('INVALID_SQL', clientMessage(error)), error.status || 400);
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
    prepared = wrapProjectSql(statement, body.project);
  } catch (error) {
    return failureResponse(error);
  }

  try {
    const executed = await executeSql(prepared);
    return json(shapeSqlResult({
      ...executed,
      returnLimit: prepared.returnLimit,
    }));
  } catch (error) {
    return failureResponse(error);
  }
}
