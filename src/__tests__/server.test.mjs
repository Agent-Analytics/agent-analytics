/**
 * Integration tests for the open-source self-hosted server.
 *
 * Uses SqliteAdapter with :memory: DB + createAnalyticsHandler from core.
 * Tests every endpoint the handler exposes.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll } from 'vitest';
import { createAnalyticsHandler } from '@agent-analytics/core';
import { SqliteAdapter } from '../db/sqlite.js';
import { makeValidateWrite, makeValidateRead } from '../auth.js';
import cloudflareWorker from '../platforms/cloudflare.js';

const PROJECT = 'test-project';
const TOKEN = 'pt_test';
const API_KEY = 'aak_secret';

let handler;
let db;

beforeAll(() => {
  db = new SqliteAdapter(':memory:');
  handler = createAnalyticsHandler({
    db,
    validateWrite: makeValidateWrite(TOKEN),
    validateRead: makeValidateRead(API_KEY),
  });
});

// --- helpers ---

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function postJSON(path, body) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
    body: JSON.stringify(body),
  });
}

function get(path, headers = {}) {
  return new Request(`http://localhost${path}`, { headers: { 'User-Agent': BROWSER_UA, ...headers } });
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

// --- /health ---

describe('GET /health', () => {
  it('returns ok', async () => {
    const { response } = await handler(get('/health'));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('ok');
    expect(data.service).toBe('agent-analytics');
  });
});

// --- /tracker.js ---

describe('GET /tracker.js', () => {
  it('returns javascript content', async () => {
    const { response } = await handler(get('/tracker.js'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/javascript');
    const text = await response.text();
    expect(text.length).toBeGreaterThan(0);
  });
});

// --- /track ---

describe('POST /track', () => {
  it('tracks a single event', async () => {
    const { response, writeOps } = await handler(postJSON('/track', {
      token: TOKEN,
      project: PROJECT,
      event: 'page_view',
      properties: { path: '/home' },
      user_id: 'user-1',
    }));
    // wait for write to finish
    if (writeOps) await Promise.all(writeOps);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
  });

  it('rejects missing project', async () => {
    const { response } = await handler(postJSON('/track', {
      token: TOKEN,
      event: 'click',
    }));
    expect(response.status).toBe(400);
  });

  it('rejects missing event', async () => {
    const { response } = await handler(postJSON('/track', {
      token: TOKEN,
      project: PROJECT,
    }));
    expect(response.status).toBe(400);
  });

  it('rejects invalid token', async () => {
    const { response } = await handler(postJSON('/track', {
      token: 'wrong',
      project: PROJECT,
      event: 'click',
    }));
    expect(response.status).toBe(403);
  });

  it('rejects missing token', async () => {
    const { response } = await handler(postJSON('/track', {
      project: PROJECT,
      event: 'click',
    }));
    expect(response.status).toBe(403);
  });

  it('tracks event with session', async () => {
    const { response, writeOps } = await handler(postJSON('/track', {
      token: TOKEN,
      project: PROJECT,
      event: 'page_view',
      properties: { path: '/about' },
      user_id: 'user-2',
      session_id: 'sess-1',
    }));
    if (writeOps) await Promise.all(writeOps);
    expect(response.status).toBe(200);
  });

  it('stitches an anonymous user to a known user via /identify', async () => {
    const anonId = 'anon-user-1';

    const tracked = await handler(postJSON('/track', {
      token: TOKEN,
      project: PROJECT,
      event: 'page_view',
      properties: { path: '/signup' },
      user_id: anonId,
      session_id: 'sess-identify',
    }));
    if (tracked.writeOps) await Promise.all(tracked.writeOps);

    const identified = await handler(postJSON('/identify', {
      token: TOKEN,
      project: PROJECT,
      previous_id: anonId,
      user_id: 'user-1',
    }));

    expect(identified.response.status).toBe(200);

    const { response } = await handler(get(`/events?project=${PROJECT}&session_id=sess-identify`, authHeaders));
    const data = await response.json();
    expect(data.events[0].user_id).toBe('user-1');
  });

  it('canonicalizes a late event after /identify has already been recorded', async () => {
    const anonId = 'anon-user-late';
    const sessionId = 'sess-identify-late';

    const identified = await handler(postJSON('/identify', {
      token: TOKEN,
      project: PROJECT,
      previous_id: anonId,
      user_id: 'user-late',
    }));

    expect(identified.response.status).toBe(200);

    const tracked = await handler(postJSON('/track', {
      token: TOKEN,
      project: PROJECT,
      event: 'signup',
      properties: { path: '/signup' },
      user_id: anonId,
      session_id: sessionId,
    }));
    if (tracked.writeOps) await Promise.all(tracked.writeOps);

    const { response: eventsResponse } = await handler(get(`/events?project=${PROJECT}&session_id=${sessionId}`, authHeaders));
    const eventsData = await eventsResponse.json();
    expect(eventsData.events[0].user_id).toBe('user-late');

    const query = postJSON('/query', {
      project: PROJECT,
      metrics: ['unique_users'],
      filters: [
        { field: 'event', op: 'eq', value: 'signup' },
        { field: 'session_id', op: 'eq', value: sessionId },
      ],
    });
    query.headers.set('X-API-Key', API_KEY);

    const { response: queryResponse } = await handler(query);
    const queryData = await queryResponse.json();
    expect(queryData.rows[0].unique_users).toBe(1);
  });
});

describe('SqliteAdapter hardening', () => {
  it('canonicalizes a delayed write that starts before /identify and commits after it', async () => {
    class RaceSqliteAdapter extends SqliteAdapter {
      beforeNextBatch = null;

      async _batch(statements) {
        if (this.beforeNextBatch) {
          const hook = this.beforeNextBatch;
          this.beforeNextBatch = null;
          await hook();
        }

        return super._batch(statements);
      }
    }

    const adapter = new RaceSqliteAdapter(':memory:');
    const anonId = 'anon-race-user';
    const canonicalId = 'user-race';
    const sessionId = 'sess-race';

    adapter.beforeNextBatch = async () => {
      await adapter.identifyUser({
        project: PROJECT,
        previous_id: anonId,
        canonical_id: canonicalId,
      });
    };

    await adapter.trackEvent({
      project: PROJECT,
      event: 'signup',
      properties: { path: '/signup' },
      user_id: anonId,
      session_id: sessionId,
      timestamp: Date.now(),
    });

    const events = await adapter.getEvents({ project: PROJECT, session_id: sessionId });
    expect(events).toHaveLength(1);
    expect(events[0].user_id).toBe(canonicalId);

    const sessions = await adapter.getSessions({ project: PROJECT, user_id: canonicalId });
    expect(sessions.some(session => session.session_id === sessionId)).toBe(true);

    adapter.db.close();
  });

  it('migrates legacy sqlite files before session-backed queries read the new country column', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'agent-analytics-'));
    const dbPath = join(tempDir, 'legacy.db');
    const legacyDb = new Database(dbPath);
    const now = Date.now();
    const today = new Date(now).toISOString().split('T')[0];

    legacyDb.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        event TEXT NOT NULL,
        properties TEXT,
        user_id TEXT,
        session_id TEXT,
        timestamp INTEGER NOT NULL,
        date TEXT NOT NULL
      );
      CREATE INDEX idx_events_project_date ON events(project_id, date);
      CREATE INDEX idx_events_session ON events(session_id);
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT,
        project_id TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        duration INTEGER DEFAULT 0,
        entry_page TEXT,
        exit_page TEXT,
        event_count INTEGER DEFAULT 1,
        is_bounce INTEGER DEFAULT 1,
        date TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_project_date ON sessions(project_id, date);
      CREATE INDEX idx_sessions_user ON sessions(project_id, user_id);
    `);

    legacyDb.prepare(`
      INSERT INTO events (id, project_id, event, properties, user_id, session_id, timestamp, date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-event', PROJECT, 'page_view', JSON.stringify({ path: '/legacy' }), 'legacy-user', 'legacy-session', now, today);
    legacyDb.prepare(`
      INSERT INTO sessions (session_id, user_id, project_id, start_time, end_time, duration, entry_page, exit_page, event_count, is_bounce, date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-session', 'legacy-user', PROJECT, now, now + 1500, 1500, '/legacy', '/legacy', 1, 1, today);
    legacyDb.close();

    const adapter = new SqliteAdapter(dbPath);

    try {
      const columns = adapter.db.prepare('PRAGMA table_info(events)').all().map(column => column.name);
      expect(columns).toContain('country');

      const result = await adapter.query({
        project: PROJECT,
        metrics: ['event_count', 'session_count', 'bounce_rate', 'avg_duration'],
        group_by: ['event'],
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].event).toBe('page_view');
      expect(result.rows[0].event_count).toBe(1);
      expect(result.rows[0].session_count).toBe(1);
    } finally {
      adapter.db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Cloudflare D1 hardening', () => {
  it('upgrades legacy D1 schemas before /track and /identify writes run', async () => {
    const legacyDb = new Database(':memory:');
    legacyDb.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        event TEXT NOT NULL,
        properties TEXT,
        user_id TEXT,
        session_id TEXT,
        timestamp INTEGER NOT NULL,
        date TEXT NOT NULL
      );
      CREATE INDEX idx_events_project_date ON events(project_id, date);
      CREATE INDEX idx_events_session ON events(session_id);
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT,
        project_id TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        duration INTEGER DEFAULT 0,
        entry_page TEXT,
        exit_page TEXT,
        event_count INTEGER DEFAULT 1,
        is_bounce INTEGER DEFAULT 1,
        date TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_project_date ON sessions(project_id, date);
      CREATE INDEX idx_sessions_user ON sessions(project_id, user_id);
    `);

    const env = {
      DB: new FakeD1Database(legacyDb),
      PROJECT_TOKENS: TOKEN,
      API_KEYS: API_KEY,
    };
    const waitUntilOps = [];
    const ctx = {
      waitUntil(promise) {
        waitUntilOps.push(promise);
      },
    };

    const trackResponse = await cloudflareWorker.fetch(postJSON('/track', {
      token: TOKEN,
      project: PROJECT,
      event: 'page_view',
      properties: { path: '/legacy-d1' },
      user_id: 'anon-d1-user',
      session_id: 'legacy-d1-session',
    }), env, ctx);
    await Promise.all(waitUntilOps);

    expect(trackResponse.status).toBe(200);

    const identifyResponse = await cloudflareWorker.fetch(postJSON('/identify', {
      token: TOKEN,
      project: PROJECT,
      previous_id: 'anon-d1-user',
      user_id: 'user-d1',
    }), env, ctx);
    expect(identifyResponse.status).toBe(200);

    const columns = legacyDb.prepare('PRAGMA table_info(events)').all().map((column) => column.name);
    expect(columns).toContain('country');

    const identityColumns = legacyDb.prepare('PRAGMA table_info(identity_map)').all().map((column) => column.name);
    expect(identityColumns).toContain('canonical_id');

    const eventUser = legacyDb.prepare('SELECT user_id FROM events WHERE session_id = ?').get('legacy-d1-session');
    expect(eventUser.user_id).toBe('user-d1');

    legacyDb.close();
  });
});

// --- /track/batch ---

describe('POST /track/batch', () => {
  it('tracks a batch of events', async () => {
    const events = [
      { project: PROJECT, event: 'click', properties: { button: 'signup' }, user_id: 'user-3' },
      { project: PROJECT, event: 'page_view', properties: { path: '/pricing' }, user_id: 'user-3', session_id: 'sess-2' },
      { project: PROJECT, event: 'page_view', properties: { path: '/docs' }, user_id: 'user-4', session_id: 'sess-3' },
    ];

    const { response, writeOps } = await handler(postJSON('/track/batch', {
      token: TOKEN,
      events,
    }));
    if (writeOps) await Promise.all(writeOps);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.count).toBe(3);
  });

  it('rejects empty events array', async () => {
    const { response } = await handler(postJSON('/track/batch', {
      token: TOKEN,
      events: [],
    }));
    expect(response.status).toBe(400);
  });

  it('rejects missing events field', async () => {
    const { response } = await handler(postJSON('/track/batch', {
      token: TOKEN,
    }));
    expect(response.status).toBe(400);
  });

  it('rejects invalid token', async () => {
    const { response } = await handler(postJSON('/track/batch', {
      token: 'wrong',
      events: [{ project: PROJECT, event: 'x' }],
    }));
    expect(response.status).toBe(403);
  });
});

// --- Read endpoints (require API key) ---

const authHeaders = { 'X-API-Key': API_KEY };

describe('GET /stats', () => {
  it('returns stats for project', async () => {
    const { response } = await handler(get(`/stats?project=${PROJECT}`, authHeaders));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBe(PROJECT);
    expect(data.totals).toBeDefined();
    expect(data.totals.total_events).toBeGreaterThan(0);
    expect(data.timeSeries).toBeDefined();
    expect(data.events).toBeDefined();
    expect(data.sessions).toBeDefined();
  });

  it('rejects without API key', async () => {
    const { response } = await handler(get(`/stats?project=${PROJECT}`));
    expect(response.status).toBe(401);
  });

  it('rejects without project param', async () => {
    const { response } = await handler(get('/stats', authHeaders));
    expect(response.status).toBe(400);
  });

  it('supports key query param', async () => {
    const { response } = await handler(get(`/stats?project=${PROJECT}&key=${API_KEY}`));
    expect(response.status).toBe(200);
  });
});

describe('GET /events', () => {
  it('returns events for project', async () => {
    const { response } = await handler(get(`/events?project=${PROJECT}`, authHeaders));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBe(PROJECT);
    expect(Array.isArray(data.events)).toBe(true);
    expect(data.events.length).toBeGreaterThan(0);
  });

  it('filters by event name', async () => {
    const { response } = await handler(get(`/events?project=${PROJECT}&event=click`, authHeaders));
    const data = await response.json();
    expect(data.events.every(e => e.event === 'click')).toBe(true);
  });

  it('filters by session_id', async () => {
    const { response } = await handler(get(`/events?project=${PROJECT}&session_id=sess-1`, authHeaders));
    const data = await response.json();
    expect(data.events.every(e => e.session_id === 'sess-1')).toBe(true);
  });

  it('rejects without API key', async () => {
    const { response } = await handler(get(`/events?project=${PROJECT}`));
    expect(response.status).toBe(401);
  });

  it('rejects without project param', async () => {
    const { response } = await handler(get('/events', authHeaders));
    expect(response.status).toBe(400);
  });
});

describe('OSS analytics endpoints', () => {
  it('returns 404 for /sessions', async () => {
    const { response } = await handler(get(`/sessions?project=${PROJECT}`, authHeaders));
    expect(response.status).toBe(404);
  });

  it('returns 200 for /query', async () => {
    const req = postJSON('/query', {
      project: PROJECT,
      metrics: ['event_count'],
    });
    req.headers.set('X-API-Key', API_KEY);
    const { response } = await handler(req);
    expect(response.status).toBe(200);
  });

  it('returns session-backed metrics for /query', async () => {
    const project = `session-metrics-${Date.now()}`;
    const now = Date.now();

    const firstPageView = await handler(postJSON('/track', {
      token: TOKEN,
      project,
      event: 'page_view',
      properties: { path: '/' },
      user_id: 'query-user-1',
      session_id: 'query-session-1',
      timestamp: now,
    }));
    if (firstPageView.writeOps) await Promise.all(firstPageView.writeOps);

    const signup = await handler(postJSON('/track', {
      token: TOKEN,
      project,
      event: 'signup',
      properties: { path: '/signup' },
      user_id: 'query-user-1',
      session_id: 'query-session-1',
      timestamp: now + 1000,
    }));
    if (signup.writeOps) await Promise.all(signup.writeOps);

    const secondPageView = await handler(postJSON('/track', {
      token: TOKEN,
      project,
      event: 'page_view',
      properties: { path: '/' },
      user_id: 'query-user-2',
      session_id: 'query-session-2',
      timestamp: now,
    }));
    if (secondPageView.writeOps) await Promise.all(secondPageView.writeOps);

    const req = postJSON('/query', {
      project,
      metrics: ['event_count', 'session_count', 'bounce_rate', 'avg_duration'],
      group_by: ['event'],
      order_by: 'event',
      order: 'asc',
    });
    req.headers.set('X-API-Key', API_KEY);
    const { response } = await handler(req);
    expect(response.status).toBe(200);
    const data = await response.json();
    const pageViewRow = data.rows.find(row => row.event === 'page_view');
    expect(pageViewRow).toBeDefined();
    expect(pageViewRow.session_count).toBe(2);
    expect(pageViewRow.bounce_rate).toBe(0.5);
    expect(pageViewRow.avg_duration).toBe(500);
  });

  it('returns 200 for /properties', async () => {
    const { response } = await handler(get(`/properties?project=${PROJECT}`, authHeaders));
    expect(response.status).toBe(200);
  });
});

// --- CORS ---

describe('OPTIONS preflight', () => {
  it('returns CORS headers', async () => {
    const req = new Request('http://localhost/track', { method: 'OPTIONS' });
    const { response } = await handler(req);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});

// --- 404 ---

describe('unknown routes', () => {
  it('returns 404', async () => {
    const { response } = await handler(get('/nonexistent'));
    expect(response.status).toBe(404);
  });
});

// --- /projects ---

describe('GET /projects', () => {
  it('lists projects that have events', async () => {
    const { response } = await handler(get('/projects', authHeaders));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data.projects)).toBe(true);
    expect(data.projects.length).toBeGreaterThan(0);
    expect(data.projects.some(project => project.id === PROJECT)).toBe(true);
  });

  it('rejects without API key', async () => {
    const { response } = await handler(get('/projects'));
    expect(response.status).toBe(401);
  });
});
