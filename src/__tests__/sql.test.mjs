/**
 * POST /sql behavior: read API key, project isolation, statement rejection,
 * row cap, and the Node read-only connection. Workers is covered through the
 * worker entry point, which can only enforce the parser.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { SqliteAdapter } from '../db/sqlite.js';
import { makeValidateWrite, makeValidateRead } from '../auth.js';
import { createOssHandler } from '../oss-handler.js';
import { handleSqlRequest } from '../sql/route.js';
import cloudflareWorker from '../platforms/cloudflare.js';

const PROJECT = 'alpha';
const OTHER = 'beta';
const TOKEN = 'pt_test';
const API_KEY = 'aak_secret';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function postJSON(path, body, headers = {}) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA, ...headers },
    body: JSON.stringify(body),
  });
}

class FakeD1Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new FakeD1Statement(this.db, this.sql, params);
  }

  _runSync() {
    return this.db.prepare(this.sql).run(...this.params);
  }

  async run() {
    return this._runSync();
  }

  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }

  async first() {
    return this.db.prepare(this.sql).get(...this.params) || null;
  }
}

class FakeD1Database {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new FakeD1Statement(this.db, sql);
  }

  async batch(statements) {
    const txn = this.db.transaction((entries) => entries.map((entry) => entry._runSync()));
    return txn(statements);
  }
}

let handler;
let adapter;

async function track(project, event, extra = {}) {
  const result = await handler(postJSON('/track', {
    token: TOKEN,
    project,
    event,
    ...extra,
  }));
  if (result.writeOps) await Promise.all(result.writeOps);
  expect(result.response.status).toBe(200);
}

async function sql(body, headers = { 'X-API-Key': API_KEY }) {
  const { response } = await handler(postJSON('/sql', body, headers));
  const data = await response.json();
  return { status: response.status, data };
}

beforeAll(async () => {
  adapter = new SqliteAdapter(':memory:');
  handler = createOssHandler({
    db: adapter,
    validateWrite: makeValidateWrite(TOKEN),
    validateRead: makeValidateRead(API_KEY),
    executeSql: (prepared) => adapter.executeReadOnly(prepared.sql, prepared.params),
  });

  await track(PROJECT, 'page_view', {
    properties: { path: '/pricing' },
    user_id: 'user-1',
    session_id: 'sess-alpha',
  });
  await track(OTHER, 'secret_event', {
    properties: { path: '/hidden' },
    user_id: 'user-2',
    session_id: 'sess-beta',
  });
});

describe('POST /sql auth and body', () => {
  it('requires the read API key', async () => {
    const { status, data } = await sql({ project: PROJECT, sql: 'SELECT event FROM events' }, {});
    expect(status).toBe(401);
    expect(data.error).toBe('AUTH_REQUIRED');
  });

  it('accepts the read API key from the query string', async () => {
    const { response } = await handler(postJSON(`/sql?key=${API_KEY}`, {
      project: PROJECT,
      sql: 'SELECT event FROM events',
    }));
    expect(response.status).toBe(200);
  });

  it('requires a project', async () => {
    const { status, data } = await sql({ sql: 'SELECT event FROM events' });
    expect(status).toBe(400);
    expect(data.error).toBe('PROJECT_REQUIRED');
  });

  it('rejects a missing sql string', async () => {
    const { status, data } = await sql({ project: PROJECT });
    expect(status).toBe(400);
    expect(data.error).toBe('INVALID_SQL');
  });

  it('rejects invalid json', async () => {
    const request = new Request('http://localhost/sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: '{',
    });
    const { response } = await handler(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('INVALID_BODY');
  });
});

describe('POST /sql project isolation', () => {
  it('returns only the requested project and the published event columns', async () => {
    const { status, data } = await sql({ project: PROJECT, sql: 'SELECT * FROM events' });
    expect(status).toBe(200);
    expect(data.columns).toEqual([
      'id', 'event', 'properties', 'user_id', 'session_id', 'timestamp', 'date', 'country',
    ]);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].event).toBe('page_view');
    expect(data.rows.map((row) => row.event)).not.toContain('secret_event');
    expect(data.count).toBe(1);
    expect(data.truncated).toBe(false);
    expect(data.statistics.rows_read).toBeNull();
    expect(data.statistics.expensive).toBe(false);
    expect(typeof data.statistics.elapsed_ms).toBe('number');
  });

  it('returns only that project from sessions', async () => {
    const { status, data } = await sql({
      project: PROJECT,
      sql: 'SELECT session_id, project_id FROM sessions',
    });
    expect(status).toBe(200);
    expect(data.rows).toEqual([{ session_id: 'sess-alpha', project_id: PROJECT }]);
  });

  it('does not expose project_id or resolved_user_id on events', async () => {
    const projectId = await sql({ project: PROJECT, sql: 'SELECT project_id FROM events' });
    expect(projectId.status).toBe(400);
    expect(projectId.data.error).toBe('INVALID_SQL');

    const resolved = await sql({ project: PROJECT, sql: 'SELECT resolved_user_id FROM events' });
    expect(resolved.status).toBe(400);
    expect(resolved.data.error).toBe('INVALID_SQL');
  });

  it('binds the project name instead of interpolating it', async () => {
    const hostile = "alpha' OR '1'='1";
    const { status, data } = await sql({
      project: hostile,
      sql: 'SELECT event FROM events',
    });
    expect(status).toBe(200);
    expect(data.rows).toEqual([]);
  });

  it('lets the caller use json_extract on properties', async () => {
    const { status, data } = await sql({
      project: PROJECT,
      sql: "SELECT json_extract(properties, '$.path') AS path FROM events",
    });
    expect(status).toBe(200);
    expect(data.columns).toEqual(['path']);
    expect(data.rows).toEqual([{ path: '/pricing' }]);
  });
});

describe('POST /sql statement rejection', () => {
  const rejected = [
    'INSERT INTO events (id, project_id, event, timestamp, date) VALUES (\'x\', \'alpha\', \'nope\', 1, \'2026-11-13\')',
    'UPDATE events SET event = event',
    'DELETE FROM events',
    'REPLACE INTO events (id, project_id, event, timestamp, date) VALUES (\'x\', \'alpha\', \'nope\', 1, \'2026-11-13\')',
    'ALTER TABLE events ADD COLUMN extra TEXT',
    'DROP TABLE events',
    'CREATE TABLE extra (id TEXT)',
    'ATTACH DATABASE \'other.db\' AS other',
    'DETACH DATABASE other',
    'PRAGMA journal_mode',
    'VACUUM',
    'REINDEX',
    'WITH t AS (SELECT 1 AS n) SELECT n FROM t',
    'SELECT event FROM events; SELECT session_id FROM sessions',
    'SELECT event FROM events; DELETE FROM events',
    'SELECT * FROM main.events',
    'SELECT * FROM temp.sessions',
    'SELECT * FROM sqlite_master',
    'SELECT * FROM sqlite_schema',
    'SELECT * FROM sqlite_temp_master',
    'SELECT * FROM identity_map',
    'SELECT * FROM user_profiles',
    'SELECT * FROM events LIMIT 1e10',
    'SELECT * FROM events LIMIT (SELECT 100000)',
    'SELECT * FROM events LIMIT -1',
    "SELECT replace('page_view', 'page_', '')",
    'SELECT event FROM events -- DELETE FROM events',
    'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT n FROM c',
    'SELECT a.event FROM events a, events b, events c',
    "SELECT 1 WHERE 'x' IN identity_map",
    'SELECT randomblob(8)',
    'SELECT zeroblob(8)',
    'SELECT a.event FROM events a JOIN events b ON a.id = b.id',
  ];

  it.each(rejected)('rejects %s', async (statement) => {
    const before = await sql({ project: PROJECT, sql: 'SELECT count(*) AS n FROM events' });
    const { status, data } = await sql({ project: PROJECT, sql: statement });
    const after = await sql({ project: PROJECT, sql: 'SELECT count(*) AS n FROM events' });
    expect(status).toBe(400);
    expect(data.error).toBe('INVALID_SQL');
    expect(after.data.rows).toEqual(before.data.rows);
  });

  it('allows a write keyword inside a string literal', async () => {
    const { status, data } = await sql({
      project: PROJECT,
      sql: "SELECT 'DELETE' AS word",
    });
    expect(status).toBe(200);
    expect(data.rows).toEqual([{ word: 'DELETE' }]);
  });

  it('allows a comment that does not contain a write keyword', async () => {
    const { status, data } = await sql({
      project: PROJECT,
      sql: "SELECT 'ok' AS word -- count page views",
    });
    expect(status).toBe(200);
    expect(data.rows).toEqual([{ word: 'ok' }]);
  });

  it('rejects sql larger than 20 KB', async () => {
    const statement = `SELECT event FROM events ${' '.repeat(20 * 1024)}`;
    const { status, data } = await sql({ project: PROJECT, sql: statement });
    expect(status).toBe(400);
    expect(data.error).toBe('INVALID_SQL');
  });
});

function utcDate(offsetDays) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays))
    .toISOString()
    .slice(0, 10);
}

function noonUtc(isoDate) {
  return Date.parse(`${isoDate}T12:00:00.000Z`);
}

describe('POST /sql time window', () => {
  const today = utcDate(0);
  const boundary = utcDate(-6);
  const outside = utcDate(-7);
  const ancient = '2020-01-01';

  beforeAll(async () => {
    await track(PROJECT, 'window_inside', {
      timestamp: noonUtc(today),
      session_id: 'sess-window-inside',
    });
    await track(PROJECT, 'window_boundary', {
      timestamp: noonUtc(boundary),
      session_id: 'sess-window-boundary',
    });
    await track(PROJECT, 'window_outside', {
      timestamp: noonUtc(outside),
      session_id: 'sess-window-outside',
    });
    await track(PROJECT, 'window_ancient', {
      timestamp: noonUtc(ancient),
      session_id: 'sess-window-ancient',
    });
  });

  function names(data) {
    const key = data.columns[0];
    return data.rows.map((row) => row[key]).sort();
  }

  it('leaves rows outside the default 7 day window out of the result', async () => {
    const { status, data } = await sql({
      project: PROJECT,
      sql: "SELECT event FROM events WHERE event LIKE 'window_%'",
    });
    expect(status).toBe(200);
    expect(names(data)).toEqual(['window_boundary', 'window_inside']);
    expect(names(data)).not.toContain('window_outside');
    expect(names(data)).not.toContain('window_ancient');
    expect(data.window).toEqual({ date_from: boundary, date_to: today });

    const sessions = await sql({
      project: PROJECT,
      sql: "SELECT session_id FROM sessions WHERE session_id LIKE 'sess-window-%'",
    });
    expect(sessions.status).toBe(200);
    expect(names(sessions.data)).toEqual(['sess-window-boundary', 'sess-window-inside']);
  });

  it('returns only rows inside an explicit date range', async () => {
    const { status, data } = await sql({
      project: PROJECT,
      sql: "SELECT event FROM events WHERE event LIKE 'window_%'",
      date_from: ancient,
      date_to: ancient,
    });
    expect(status).toBe(200);
    expect(names(data)).toEqual(['window_ancient']);
    expect(data.window).toEqual({ date_from: ancient, date_to: ancient });

    const sessions = await sql({
      project: PROJECT,
      sql: "SELECT session_id FROM sessions WHERE session_id LIKE 'sess-window-%'",
      date_from: outside,
      date_to: outside,
    });
    expect(names(sessions.data)).toEqual(['sess-window-outside']);
  });

  it('honors days and rejects a window that breaks the contract', async () => {
    const oneDay = await sql({
      project: PROJECT,
      sql: "SELECT event FROM events WHERE event LIKE 'window_%'",
      days: 1,
    });
    expect(oneDay.status).toBe(200);
    expect(names(oneDay.data)).toEqual(['window_inside']);
    expect(oneDay.data.window).toEqual({ date_from: today, date_to: today });

    const eightDays = await sql({
      project: PROJECT,
      sql: "SELECT event FROM events WHERE event LIKE 'window_%'",
      days: 8,
    });
    expect(names(eightDays.data)).toEqual(['window_boundary', 'window_inside', 'window_outside']);

    const invalid = [
      { days: 0 },
      { days: 91 },
      { days: '7' },
      { days: 7, date_from: ancient },
      { date_from: ancient },
      { date_from: today, date_to: ancient },
      { date_from: utcDate(-90), date_to: today },
    ];
    for (const body of invalid) {
      const { status, data } = await sql({
        project: PROJECT,
        sql: 'SELECT event FROM events',
        ...body,
      });
      expect(status).toBe(400);
      expect(data.error).toBe('INVALID_WINDOW');
    }
  });
});

describe('POST /sql join limit', () => {
  it('rejects a third events reference', async () => {
    const { status, data } = await sql({
      project: PROJECT,
      sql: 'SELECT a.event FROM events a, events b, events c',
    });
    expect(status).toBe(400);
    expect(data.error).toBe('INVALID_SQL');
  });

  it('rejects a self-join and allows one events row joined to sessions', async () => {
    const selfJoin = await sql({
      project: PROJECT,
      sql: "SELECT a.event FROM events a JOIN events b ON a.id = b.id WHERE a.event = 'page_view'",
    });
    expect(selfJoin.status).toBe(400);
    expect(selfJoin.data.error).toBe('INVALID_SQL');

    const { status, data } = await sql({
      project: PROJECT,
      sql: "SELECT events.event FROM events JOIN sessions ON events.session_id = sessions.session_id WHERE events.event = 'page_view'",
    });
    expect(status).toBe(200);
    expect(data.rows).toEqual([{ event: 'page_view' }]);
  });

  it('rejects x IN identity_map', async () => {
    const { status, data } = await sql({
      project: PROJECT,
      sql: "SELECT 1 WHERE 'x' IN identity_map",
    });
    expect(status).toBe(400);
    expect(data.error).toBe('INVALID_SQL');
  });
});

describe('POST /sql row cap', () => {
  it('returns at most 1000 rows and sets truncated when more exist', async () => {
    const capAdapter = new SqliteAdapter(':memory:');
    let rowsRead = 0;
    const countingHandler = createOssHandler({
      db: capAdapter,
      validateWrite: makeValidateWrite(TOKEN),
      validateRead: makeValidateRead(API_KEY),
      executeSql: (prepared) => {
        const result = capAdapter.executeReadOnly(prepared.sql, prepared.params);
        rowsRead = result.rows.length;
        return result;
      },
    });
    const events = [];
    for (let i = 0; i < 1005; i += 1) {
      events.push({ project: PROJECT, event: 'bulk', properties: { n: i } });
    }
    for (let offset = 0; offset < events.length; offset += 100) {
      const result = await countingHandler(postJSON('/track/batch', {
        token: TOKEN,
        events: events.slice(offset, offset + 100),
      }));
      if (result.writeOps) await Promise.all(result.writeOps);
      expect(result.response.status).toBe(200);
    }

    async function capSql(statement) {
      const { response } = await countingHandler(postJSON('/sql', {
        project: PROJECT,
        sql: statement,
      }, { 'X-API-Key': API_KEY }));
      const data = await response.json();
      return { status: response.status, data };
    }

    const uncapped = await capSql("SELECT event FROM events WHERE event = 'bulk'");
    expect(uncapped.status).toBe(200);
    expect(uncapped.data.count).toBe(1000);
    expect(uncapped.data.rows).toHaveLength(1000);
    expect(uncapped.data.truncated).toBe(true);
    expect(uncapped.data.rows.every((row) => row.event === 'bulk')).toBe(true);

    const capped = await capSql("SELECT event FROM events WHERE event = 'bulk' LIMIT 5000");
    expect(capped.data.count).toBe(1000);
    expect(capped.data.truncated).toBe(true);

    const small = await capSql("SELECT event FROM events WHERE event = 'bulk' LIMIT 2");
    expect(small.data.rows).toEqual([{ event: 'bulk' }, { event: 'bulk' }]);
    expect(small.data.truncated).toBe(false);

    const commented = await capSql("SELECT event FROM events WHERE event = 'bulk' -- page views");
    expect(commented.data.count).toBe(1000);
    expect(commented.data.truncated).toBe(true);

    const commentedStar = await capSql('SELECT * FROM events -- c');
    expect(commentedStar.status).toBe(200);
    expect(rowsRead).toBeLessThanOrEqual(1001);
    expect(commentedStar.data.count).toBe(1000);
    expect(commentedStar.data.truncated).toBe(true);
    expect(commentedStar.data.rows[0].event).toBe('bulk');
  });
});

describe('Node read-only connection', () => {
  it('rejects a write issued on the SQL connection', () => {
    expect(() => adapter.executeReadOnly(
      "INSERT INTO events (id, project_id, event, timestamp, date) VALUES ('x', 'alpha', 'nope', 1, '2026-11-13') RETURNING id",
    )).toThrow(/readonly/i);
  });

  it('sees committed rows through a read-only file connection and still refuses writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-sql-'));
    const fileAdapter = new SqliteAdapter(join(dir, 'analytics.db'));
    try {
      await fileAdapter.trackEvent({
        project: PROJECT,
        event: 'file_event',
        timestamp: Date.now(),
      });
      const result = fileAdapter.executeReadOnly('SELECT event FROM events');
      expect(result.rows).toEqual([['file_event']]);
      expect(() => fileAdapter.executeReadOnly('DELETE FROM events RETURNING session_id')).toThrow(/readonly/i);
    } finally {
      fileAdapter.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SQL response statistics', () => {
  it('marks the call expensive when rows_read exceeds 1000000', async () => {
    const response = await handleSqlRequest(postJSON('/sql', {
      project: PROJECT,
      sql: 'SELECT event FROM events',
    }, { 'X-API-Key': API_KEY }), {
      validateRead: () => ({ valid: true }),
      executeSql: async () => ({
        columns: ['event'],
        rows: [['page_view']],
        elapsed_ms: 12.4,
        rows_read: 1_000_001,
      }),
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.rows).toEqual([{ event: 'page_view' }]);
    expect(data.columns).toEqual(['event']);
    expect(data.statistics).toEqual({
      elapsed_ms: 12,
      rows_read: 1_000_001,
      expensive: true,
    });
  });

  it('returns SQL_TIMEOUT when execution is still running after 10 seconds', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const responsePromise = handleSqlRequest(postJSON('/sql', {
        project: PROJECT,
        sql: 'SELECT event FROM events',
      }, { 'X-API-Key': API_KEY }), {
        validateRead: () => ({ valid: true }),
        executeSql: () => new Promise(() => {}),
      }).then((response) => {
        settled = true;
        return response;
      });

      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const response = await responsePromise;
      expect(response.status).toBe(504);
      const data = await response.json();
      expect(data.error).toBe('SQL_TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a D1 user SQL error to INVALID_SQL', async () => {
    const response = await handleSqlRequest(postJSON('/sql', {
      project: PROJECT,
      sql: 'SELECT event FROM events',
    }, { 'X-API-Key': API_KEY }), {
      validateRead: () => ({ valid: true }),
      executeSql: async () => {
        throw new Error('D1_ERROR: no such column: nope: SQLITE_ERROR');
      },
    });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('INVALID_SQL');
    expect(data.message).toMatch(/no such column/);
  });

  it('maps a SQLite user SQL error from the read-only connection to INVALID_SQL', async () => {
    const { status, data } = await sql({
      project: PROJECT,
      sql: 'SELECT missing_col FROM events',
    });
    expect(status).toBe(400);
    expect(data.error).toBe('INVALID_SQL');
    expect(data.message).toMatch(/no such column/);
  });

  it('maps a database timeout to SQL_TIMEOUT', async () => {
    const response = await handleSqlRequest(postJSON('/sql', {
      project: PROJECT,
      sql: 'SELECT event FROM events',
    }, { 'X-API-Key': API_KEY }), {
      validateRead: () => ({ valid: true }),
      executeSql: async () => {
        throw new Error('D1 DB exceeded its CPU time limit');
      },
    });
    expect(response.status).toBe(504);
    const data = await response.json();
    expect(data.error).toBe('SQL_TIMEOUT');
  });
});

describe('Workers POST /sql', () => {
  it('scopes rows to the project and refuses a write on the parser path', async () => {
    const workerAdapter = new SqliteAdapter(':memory:');
    const database = workerAdapter.db;
    const env = {
      DB: new FakeD1Database(database),
      PROJECT_TOKENS: TOKEN,
      API_KEYS: API_KEY,
    };
    const pending = [];
    const ctx = {
      waitUntil(promise) {
        pending.push(promise);
      },
    };

    const tracked = await cloudflareWorker.fetch(postJSON('/track', {
      token: TOKEN,
      project: PROJECT,
      event: 'page_view',
      properties: { path: '/docs' },
      session_id: 'worker-sess',
    }), env, ctx);
    await Promise.all(pending);
    expect(tracked.status).toBe(200);

    const other = await cloudflareWorker.fetch(postJSON('/track', {
      token: TOKEN,
      project: OTHER,
      event: 'secret_event',
    }), env, ctx);
    await Promise.all(pending);
    expect(other.status).toBe(200);

    const selected = await cloudflareWorker.fetch(postJSON('/sql', {
      project: PROJECT,
      sql: 'SELECT event FROM events',
    }, { 'X-API-Key': API_KEY }), env, ctx);
    expect(selected.status).toBe(200);
    const selectedData = await selected.json();
    expect(selectedData.rows).toEqual([{ event: 'page_view' }]);
    expect(selectedData.truncated).toBe(false);

    const before = database.prepare('SELECT count(*) AS n FROM events').get().n;
    const deleted = await cloudflareWorker.fetch(postJSON('/sql', {
      project: PROJECT,
      sql: 'DELETE FROM events',
    }, { 'X-API-Key': API_KEY }), env, ctx);
    expect(deleted.status).toBe(400);
    const deletedData = await deleted.json();
    expect(deletedData.error).toBe('INVALID_SQL');
    const after = database.prepare('SELECT count(*) AS n FROM events').get().n;
    expect(after).toBe(before);

    const bypass = await cloudflareWorker.fetch(postJSON('/sql', {
      project: PROJECT,
      sql: 'SELECT event FROM main.events',
    }, { 'X-API-Key': API_KEY }), env, ctx);
    expect(bypass.status).toBe(400);

    const unauthenticated = await cloudflareWorker.fetch(postJSON('/sql', {
      project: PROJECT,
      sql: 'SELECT event FROM events',
    }), env, ctx);
    expect(unauthenticated.status).toBe(401);

    workerAdapter.close();
  });
});
