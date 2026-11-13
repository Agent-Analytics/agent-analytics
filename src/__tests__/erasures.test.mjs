/**
 * Synchronous POST /erasures on the OSS server.
 * The read API key is the caller. A second project that stores the same
 * user ids must stay untouched.
 */
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import { createAnalyticsHandler } from '@agent-analytics/core';
import { SqliteAdapter } from '../db/sqlite.js';
import { ensureD1Compatibility } from '../db/d1.js';
import { makeValidateWrite, makeValidateRead } from '../auth.js';
import { createErasureHandler } from '../erasures/handler.js';
import { CREATE_ERASURE_INDEX, CREATE_ERASURE_REQUESTS } from '../erasures/sql.js';
import { erasureFingerprint } from '../erasures/hash.js';
import { ERASURE_ACCOUNT_ID, ERASURE_REQUESTED_BY } from '../erasures/receipt.js';
import cloudflareWorker from '../platforms/cloudflare.js';

const TOKEN = 'pt_test';
const API_KEY = 'aak_secret';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const open = [];

afterEach(() => {
  while (open.length > 0) {
    const db = open.pop();
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

function setup(options = {}) {
  const db = new SqliteAdapter(':memory:');
  open.push(db);
  const validateRead = makeValidateRead(API_KEY);
  const handler = createErasureHandler(
    createAnalyticsHandler({
      db,
      validateWrite: makeValidateWrite(TOKEN),
      validateRead,
    }),
    { db, validateRead, ...options },
  );
  return { db, handler, raw: db.db };
}

function postJSON(path, body, headers = {}) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA, ...headers },
    body: JSON.stringify(body),
  });
}

function get(path, headers = {}) {
  return new Request(`http://localhost${path}`, {
    headers: { 'User-Agent': BROWSER_UA, ...headers },
  });
}

const authHeaders = { 'X-API-Key': API_KEY };

async function erase(handler, body, headers = authHeaders) {
  const { response } = await handler(postJSON('/erasures', body, headers));
  const data = await response.json();
  return { status: response.status, data, text: JSON.stringify(data) };
}

async function track(handler, body) {
  const result = await handler(postJSON('/track', { token: TOKEN, ...body }));
  if (result.writeOps) await Promise.all(result.writeOps);
  expect(result.response.status).toBe(200);
}

function insertEvent(raw, { id, project, userId, sessionId = null, properties = null }) {
  raw.prepare(
    `INSERT INTO events (id, project_id, event, properties, user_id, session_id, timestamp, date)
     VALUES (?, ?, 'page_view', ?, ?, ?, 1, '2026-11-13')`,
  ).run(id, project, properties ? JSON.stringify(properties) : null, userId, sessionId);
}

function insertSession(raw, { sessionId, project, userId }) {
  raw.prepare(
    `INSERT INTO sessions (session_id, user_id, project_id, start_time, end_time, duration, event_count, is_bounce, date)
     VALUES (?, ?, ?, 1, 2, 1, 1, 1, '2026-11-13')`,
  ).run(sessionId, userId, project);
}

function insertIdentity(raw, { previousId, canonicalId, project }) {
  raw.prepare(
    `INSERT INTO identity_map (previous_id, canonical_id, project_id, created_at)
     VALUES (?, ?, ?, 1)`,
  ).run(previousId, canonicalId, project);
}

function snapshot(raw, project) {
  return {
    events: raw.prepare(
      'SELECT id, user_id, session_id, properties FROM events WHERE project_id = ? ORDER BY id',
    ).all(project),
    sessions: raw.prepare(
      'SELECT session_id, user_id FROM sessions WHERE project_id = ? ORDER BY session_id',
    ).all(project),
    identity: raw.prepare(
      'SELECT previous_id, canonical_id FROM identity_map WHERE project_id = ? ORDER BY previous_id',
    ).all(project),
  };
}

function countEvents(raw, project) {
  return raw.prepare('SELECT COUNT(*) AS n FROM events WHERE project_id = ?').get(project).n;
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

describe('POST /erasures auth and body', () => {
  it('requires the read API key and leaves analytics routes in place', async () => {
    const { handler } = setup();
    const missing = await erase(handler, {
      project: 'missing',
      idempotency_key: 'k1',
      confirm: 'erase',
      user_id: 'user-1',
    }, {});
    expect(missing.status).toBe(401);
    expect(missing.data.error).toBe('AUTH_REQUIRED');

    const { response } = await handler(get('/health'));
    expect(response.status).toBe(200);
  });

  it('accepts the read API key from the query string', async () => {
    const { handler, raw } = setup();
    insertEvent(raw, { id: 'e1', project: 'alpha', userId: 'user-1' });
    const { response } = await handler(postJSON('/erasures?key=' + API_KEY, {
      project: 'alpha',
      idempotency_key: 'query-key',
      confirm: 'erase',
      user_id: 'user-1',
    }));
    expect(response.status).toBe(200);
    expect(countEvents(raw, 'alpha')).toBe(0);
  });

  it('rejects a missing confirm, two subjects, an empty subject, and a subject over 256 characters', async () => {
    const { handler, raw } = setup();
    insertEvent(raw, { id: 'e1', project: 'alpha', userId: 'user-1' });
    insertEvent(raw, { id: 'e2', project: 'beta', userId: 'user-1' });
    const before = snapshot(raw, 'beta');

    const cases = [
      { project: 'alpha', idempotency_key: 'k', user_id: 'user-1' },
      { project: 'alpha', idempotency_key: 'k', confirm: 'delete', user_id: 'user-1' },
      { project: 'alpha', idempotency_key: 'k', confirm: 'erase', user_id: 'user-1', session_id: 'sess-1' },
      { project: 'alpha', idempotency_key: 'k', confirm: 'erase', user_id: '' },
      { project: 'alpha', idempotency_key: 'k', confirm: 'erase', user_id: 'x'.repeat(257) },
      { project: 'alpha', idempotency_key: 'k', confirm: 'erase' },
      { idempotency_key: 'k', confirm: 'erase', user_id: 'user-1' },
      { project: 'alpha', confirm: 'erase', user_id: 'user-1' },
    ];

    for (const body of cases) {
      const result = await erase(handler, body);
      expect(result.status).toBe(400);
      expect(result.data.error).toBe('INVALID_ERASURE');
      expect(result.text).not.toContain('user-1');
    }

    expect(countEvents(raw, 'alpha')).toBe(1);
    expect(snapshot(raw, 'beta')).toEqual(before);
  });

  it('returns 404 when the project has no rows', async () => {
    const { handler } = setup();
    const result = await erase(handler, {
      project: 'unknown-project',
      idempotency_key: 'missing-project',
      confirm: 'erase',
      user_id: 'user-1',
    });
    expect(result.status).toBe(404);
    expect(result.data.error).toBe('PROJECT_NOT_FOUND');
  });

  it('rejects portfolio erasure', async () => {
    const { handler, raw } = setup();
    insertEvent(raw, { id: 'e1', project: 'alpha', userId: 'person@example.com' });
    const result = await erase(handler, {
      project: 'alpha',
      idempotency_key: 'portfolio',
      confirm: 'erase',
      email: 'person@example.com',
      portfolio: true,
    });
    expect(result.status).toBe(400);
    expect(result.data.error).toBe('INVALID_ERASURE');
    expect(countEvents(raw, 'alpha')).toBe(1);
    expect(result.text).not.toContain('person@example.com');
  });
});

describe('identity_map walk', () => {
  it('deletes the anonymous id and the identified id in one project only', async () => {
    const { handler, raw } = setup();
    const anon = 'anon-walk-user';
    const known = 'known-walk-user';

    await track(handler, {
      project: 'walk-a',
      event: 'page_view',
      user_id: anon,
      session_id: 'walk-a-session',
      properties: { path: '/pricing' },
    });
    const identified = await handler(postJSON('/identify', {
      token: TOKEN,
      project: 'walk-a',
      previous_id: anon,
      user_id: known,
    }));
    expect(identified.response.status).toBe(200);

    insertEvent(raw, { id: 'late-anon', project: 'walk-a', userId: anon, sessionId: 'walk-a-late' });
    insertSession(raw, { sessionId: 'walk-a-late', project: 'walk-a', userId: anon });
    insertEvent(raw, {
      id: 'property-only',
      project: 'walk-a',
      userId: 'someone-else',
      properties: { note: anon },
    });

    insertEvent(raw, { id: 'beta-known', project: 'walk-b', userId: known, sessionId: 'walk-b-session' });
    insertEvent(raw, { id: 'beta-anon', project: 'walk-b', userId: anon, sessionId: 'walk-b-anon' });
    insertSession(raw, { sessionId: 'walk-b-session', project: 'walk-b', userId: known });
    insertSession(raw, { sessionId: 'walk-b-anon', project: 'walk-b', userId: anon });
    insertIdentity(raw, { previousId: anon, canonicalId: known, project: 'walk-b' });
    insertEvent(raw, {
      id: 'beta-property',
      project: 'walk-b',
      userId: 'someone-else',
      properties: { note: known },
    });

    const alphaUsers = raw.prepare(
      'SELECT user_id FROM events WHERE project_id = ? ORDER BY user_id',
    ).all('walk-a').map((row) => row.user_id);
    expect(alphaUsers).toContain(anon);
    expect(alphaUsers).toContain(known);

    const betaBefore = snapshot(raw, 'walk-b');
    const result = await erase(handler, {
      project: 'walk-a',
      idempotency_key: 'walk-anon',
      confirm: 'erase',
      user_id: anon,
    });

    expect(result.status).toBe(200);
    expect(result.data.status).toBe('completed');
    expect(result.data.project).toBe('walk-a');
    expect(result.data.subject_type).toBe('user_id');
    expect(result.data.id).toMatch(/^era_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.data.replay_included).toBe(true);
    expect(result.data.counts.replay_sessions).toBe(0);
    expect(result.data.counts.replay_objects).toBe(0);
    expect(result.data.counts.events).toBeGreaterThanOrEqual(2);
    expect(result.data.counts.identity_rows).toBe(1);
    expect(result.data.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.text).not.toContain(anon);
    expect(result.text).not.toContain(known);

    const alpha = snapshot(raw, 'walk-a');
    expect(alpha.events).toEqual([{
      id: 'property-only',
      user_id: 'someone-else',
      session_id: null,
      properties: JSON.stringify({ note: anon }),
    }]);
    expect(alpha.sessions).toEqual([]);
    expect(alpha.identity).toEqual([]);
    expect(snapshot(raw, 'walk-b')).toEqual(betaBefore);

    const stored = raw.prepare('SELECT * FROM erasure_requests WHERE id = ?').get(result.data.id);
    expect(stored.requested_by).toBe(ERASURE_REQUESTED_BY);
    expect(stored.account_id).toBe(ERASURE_ACCOUNT_ID);
    expect(stored.project_name).toBe('walk-a');
    expect(stored.subject_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(anon);
    expect(JSON.stringify(stored)).not.toContain(known);
    expect(JSON.stringify(stored)).not.toContain(API_KEY);
  });
});

describe('session_id erasure', () => {
  it('deletes that session only and does not walk identity or the other project', async () => {
    const { handler, raw } = setup();
    const user = 'shared-session-user';
    insertEvent(raw, { id: 's1-event', project: 'sess-a', userId: user, sessionId: 'sess-1' });
    insertEvent(raw, { id: 's2-event', project: 'sess-a', userId: user, sessionId: 'sess-2' });
    insertSession(raw, { sessionId: 'sess-1', project: 'sess-a', userId: user });
    insertSession(raw, { sessionId: 'sess-2', project: 'sess-a', userId: user });
    insertIdentity(raw, { previousId: 'anon-shared', canonicalId: user, project: 'sess-a' });

    insertEvent(raw, { id: 'beta-event', project: 'sess-b', userId: user, sessionId: 'sess-b-1' });
    insertSession(raw, { sessionId: 'sess-b-1', project: 'sess-b', userId: user });
    insertIdentity(raw, { previousId: 'anon-shared', canonicalId: user, project: 'sess-b' });
    const betaBefore = snapshot(raw, 'sess-b');

    const result = await erase(handler, {
      project: 'sess-a',
      idempotency_key: 'session-only',
      confirm: 'erase',
      session_id: 'sess-1',
      include_replays: false,
    });

    expect(result.status).toBe(200);
    expect(result.data.subject_type).toBe('session_id');
    expect(result.data.replay_included).toBe(false);
    expect(result.data.counts).toMatchObject({
      events: 1,
      sessions: 1,
      identity_rows: 0,
      profiles: 0,
      email_lookups: 0,
      replay_sessions: 0,
      replay_objects: 0,
    });

    expect(snapshot(raw, 'sess-a')).toEqual({
      events: [{ id: 's2-event', user_id: user, session_id: 'sess-2', properties: null }],
      sessions: [{ session_id: 'sess-2', user_id: user }],
      identity: [{ previous_id: 'anon-shared', canonical_id: user }],
    });
    expect(snapshot(raw, 'sess-b')).toEqual(betaBefore);
    expect(result.text).not.toContain('sess-1');
    expect(result.text).not.toContain(user);
  });
});

describe('email erasure', () => {
  it('does not delete rows when there is no email lookup index', async () => {
    const { handler, raw } = setup();
    const email = 'person@example.com';
    insertEvent(raw, { id: 'email-a', project: 'mail-a', userId: email });
    insertEvent(raw, { id: 'email-b', project: 'mail-b', userId: email });
    const betaBefore = snapshot(raw, 'mail-b');

    const result = await erase(handler, {
      project: 'mail-a',
      idempotency_key: 'email-1',
      confirm: 'erase',
      email,
    });

    expect(result.status).toBe(200);
    expect(result.data.status).toBe('completed');
    expect(result.data.subject_type).toBe('email');
    expect(result.data.counts).toEqual({
      events: 0,
      sessions: 0,
      identity_rows: 0,
      profiles: 0,
      email_lookups: 0,
      replay_sessions: 0,
      replay_objects: 0,
    });
    expect(countEvents(raw, 'mail-a')).toBe(1);
    expect(snapshot(raw, 'mail-b')).toEqual(betaBefore);
    expect(result.text).not.toContain(email);
  });
});

describe('idempotency', () => {
  it('returns the original receipt and does not delete rows added later', async () => {
    const { handler, raw } = setup();
    const user = 'idem-user';
    insertEvent(raw, { id: 'idem-a1', project: 'idem-a', userId: user });
    insertEvent(raw, { id: 'idem-b1', project: 'idem-b', userId: user });
    const betaBefore = snapshot(raw, 'idem-b');

    const body = {
      project: 'idem-a',
      idempotency_key: 'same-key',
      confirm: 'erase',
      user_id: user,
    };
    const first = await erase(handler, body);
    expect(first.status).toBe(200);
    expect(first.data.counts.events).toBe(1);
    expect(countEvents(raw, 'idem-a')).toBe(0);

    insertEvent(raw, { id: 'idem-a2', project: 'idem-a', userId: user });
    const second = await erase(handler, { ...body, note: 'ignored extra field' });
    expect(second.status).toBe(200);
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.counts.events).toBe(1);
    expect(countEvents(raw, 'idem-a')).toBe(1);
    expect(snapshot(raw, 'idem-b')).toEqual(betaBefore);

    const conflict = await erase(handler, { ...body, user_id: 'other-user' });
    expect(conflict.status).toBe(409);
    expect(conflict.data.error).toBe('IDEMPOTENCY_CONFLICT');
    expect(countEvents(raw, 'idem-a')).toBe(1);
    expect(snapshot(raw, 'idem-b')).toEqual(betaBefore);

    const otherProject = await erase(handler, { ...body, project: 'idem-b' });
    expect(otherProject.status).toBe(409);
    expect(snapshot(raw, 'idem-b')).toEqual(betaBefore);
  });

  it('continues a failed receipt and keeps the other project', async () => {
    const { handler, raw } = setup();
    const user = 'retry-user';
    insertEvent(raw, { id: 'left', project: 'retry-a', userId: user });
    insertEvent(raw, { id: 'beta-left', project: 'retry-b', userId: user });
    const body = {
      project: 'retry-a',
      idempotencyKey: 'retry-key',
      subjectType: 'user_id',
      subject: user,
      includeReplays: true,
      portfolio: false,
      confirmLarge: false,
    };
    const fingerprint = await erasureFingerprint(body);
    const now = Date.now();
    raw.prepare(
      `INSERT INTO erasure_requests (
         id, account_id, project_id, project_name, idempotency_key,
         subject_type, subject_hash, status, counts_json, error,
         created_at, started_at, completed_at, requested_by, body_hash, replay_included
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, 'erasure failed', ?, ?, NULL, ?, ?, 1)`,
    ).run(
      'era_00000000000000000000000001',
      ERASURE_ACCOUNT_ID,
      'retry-a',
      'retry-a',
      'retry-key',
      'user_id',
      fingerprint.subjectHash,
      JSON.stringify({
        events: 2,
        sessions: 0,
        identity_rows: 0,
        profiles: 0,
        email_lookups: 0,
        replay_sessions: 0,
        replay_objects: 0,
      }),
      now,
      now,
      ERASURE_REQUESTED_BY,
      fingerprint.bodyHash,
    );

    const betaBefore = snapshot(raw, 'retry-b');
    const result = await erase(handler, {
      project: 'retry-a',
      idempotency_key: 'retry-key',
      confirm: 'erase',
      user_id: user,
    });

    expect(result.status).toBe(200);
    expect(result.data.id).toBe('era_00000000000000000000000001');
    expect(result.data.status).toBe('completed');
    expect(result.data.counts.events).toBe(3);
    expect(countEvents(raw, 'retry-a')).toBe(0);
    expect(snapshot(raw, 'retry-b')).toEqual(betaBefore);
    expect(result.text).not.toContain(user);
  });
});

describe('confirm_large', () => {
  it('refuses a subject over 100000 events until confirm_large is set, and leaves the other project', async () => {
    const { handler, raw } = setup();
    const user = 'large-user';
    const insert = raw.prepare(
      `INSERT INTO events (id, project_id, event, user_id, timestamp, date)
       VALUES (?, 'large-a', 'page_view', ?, 1, '2026-11-13')`,
    );
    const write = raw.transaction((count) => {
      for (let index = 0; index < count; index += 1) insert.run(`large-${index}`, user);
    });
    write(100001);
    insertEvent(raw, { id: 'large-b', project: 'large-b', userId: user });

    const refused = await erase(handler, {
      project: 'large-a',
      idempotency_key: 'large-1',
      confirm: 'erase',
      user_id: user,
    });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toBe('CONFIRM_LARGE_REQUIRED');
    expect(countEvents(raw, 'large-a')).toBe(100001);
    expect(countEvents(raw, 'large-b')).toBe(1);
    expect(refused.text).not.toContain(user);

    const accepted = await erase(handler, {
      project: 'large-a',
      idempotency_key: 'large-2',
      confirm: 'erase',
      confirm_large: true,
      user_id: user,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.data.status).toBe('completed');
    expect(accepted.data.counts.events).toBe(100001);
    expect(countEvents(raw, 'large-a')).toBe(0);
    expect(countEvents(raw, 'large-b')).toBe(1);

    const replay = await erase(handler, {
      project: 'large-a',
      idempotency_key: 'large-2',
      confirm: 'erase',
      confirm_large: true,
      user_id: user,
    });
    expect(replay.status).toBe(200);
    expect(replay.data.id).toBe(accepted.data.id);
    expect(countEvents(raw, 'large-b')).toBe(1);
  }, 60000);
});

describe('GET /erasures', () => {
  it('returns one receipt and the 100 newest for the project', async () => {
    const { handler, raw } = setup();
    insertEvent(raw, { id: 'listed', project: 'list-a', userId: 'list-user' });
    const created = await erase(handler, {
      project: 'list-a',
      idempotency_key: 'list-key',
      confirm: 'erase',
      user_id: 'list-user',
    });
    expect(created.status).toBe(200);

    const { response } = await handler(get(`/erasures/${created.data.id}`, authHeaders));
    expect(response.status).toBe(200);
    const one = await response.json();
    expect(one).toEqual(created.data);
    expect(JSON.stringify(one)).not.toContain('list-user');

    const missing = await handler(get('/erasures/era_00000000000000000000000099', authHeaders));
    expect(missing.response.status).toBe(404);

    const unauthenticated = await handler(get(`/erasures/${created.data.id}`));
    expect(unauthenticated.response.status).toBe(401);

    raw.prepare('UPDATE erasure_requests SET created_at = 0 WHERE id = ?').run(created.data.id);

    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index + 1).padStart(26, '0');
      raw.prepare(
        `INSERT INTO erasure_requests (
           id, account_id, project_id, project_name, idempotency_key,
           subject_type, subject_hash, status, counts_json, error,
           created_at, started_at, completed_at, requested_by, body_hash, replay_included
         ) VALUES (?, ?, 'list-a', 'list-a', ?, 'user_id', ?, 'completed', '{}', NULL, ?, ?, ?, ?, ?, 1)`,
      ).run(
        `era_${suffix}`,
        ERASURE_ACCOUNT_ID,
        `list-extra-${index}`,
        'ab'.repeat(32),
        index + 1,
        index + 1,
        index + 1,
        ERASURE_REQUESTED_BY,
        'cd'.repeat(32),
      );
    }
    raw.prepare(
      `INSERT INTO erasure_requests (
         id, account_id, project_id, project_name, idempotency_key,
         subject_type, subject_hash, status, counts_json, error,
         created_at, started_at, completed_at, requested_by, body_hash, replay_included
       ) VALUES (?, ?, 'list-b', 'list-b', 'other-project', 'user_id', ?, 'completed', '{}', NULL, 1000, 1000, 1000, ?, ?, 1)`,
    ).run(
      `era_${'Z'.repeat(26)}`,
      ERASURE_ACCOUNT_ID,
      'ef'.repeat(32),
      ERASURE_REQUESTED_BY,
      '11'.repeat(32),
    );

    const listed = await handler(get('/erasures?project=list-a', authHeaders));
    expect(listed.response.status).toBe(200);
    const payload = await listed.response.json();
    expect(payload.project).toBe('list-a');
    expect(payload.erasures).toHaveLength(100);
    expect(payload.erasures[0].id).toBe(`era_${String(101).padStart(26, '0')}`);
    expect(payload.erasures.some((row) => row.id === `era_${'Z'.repeat(26)}`)).toBe(false);
    expect(payload.erasures.some((row) => row.id === `era_${String(1).padStart(26, '0')}`)).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('list-user');

    const noProject = await handler(get('/erasures', authHeaders));
    expect(noProject.response.status).toBe(400);
    expect((await noProject.response.json()).error).toBe('PROJECT_REQUIRED');

    const unknown = await handler(get('/erasures?project=does-not-exist', authHeaders));
    expect(unknown.response.status).toBe(404);
    expect((await unknown.response.json()).error).toBe('PROJECT_NOT_FOUND');
  });
});

describe('schema', () => {
  it('keeps schema.sql aligned with the D1 compatibility statements', () => {
    const schema = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
    expect(schema).toContain(CREATE_ERASURE_REQUESTS);
    expect(schema).toContain(CREATE_ERASURE_INDEX);
  });

  it('creates erasure_requests on a legacy D1 database', async () => {
    const legacy = new Database(':memory:');
    open.push({ close: () => legacy.close() });
    legacy.exec(`
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
    `);
    await ensureD1Compatibility(new FakeD1Database(legacy));
    const tables = legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    expect(tables).toContain('erasure_requests');
    expect(tables).toContain('identity_map');
  });
});

describe('Workers erasure route', () => {
  it('erases one project and leaves the same user id in the other project', async () => {
    const adapter = new SqliteAdapter(':memory:');
    open.push(adapter);
    const env = {
      DB: new FakeD1Database(adapter.db),
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
      project: 'worker-a',
      event: 'page_view',
      user_id: 'worker-user',
      session_id: 'worker-a-session',
    }), env, ctx);
    await Promise.all(pending);
    expect(tracked.status).toBe(200);

    const other = await cloudflareWorker.fetch(postJSON('/track', {
      token: TOKEN,
      project: 'worker-b',
      event: 'page_view',
      user_id: 'worker-user',
      session_id: 'worker-b-session',
    }), env, ctx);
    await Promise.all(pending);
    expect(other.status).toBe(200);

    const erased = await cloudflareWorker.fetch(postJSON('/erasures', {
      project: 'worker-a',
      idempotency_key: 'worker-erase',
      confirm: 'erase',
      user_id: 'worker-user',
    }, authHeaders), env, ctx);
    expect(erased.status).toBe(200);
    const body = await erased.json();
    expect(body.status).toBe('completed');
    expect(body.counts.events).toBe(1);
    expect(JSON.stringify(body)).not.toContain('worker-user');

    const remaining = adapter.db.prepare(
      'SELECT project_id, user_id FROM events ORDER BY project_id',
    ).all();
    expect(remaining).toEqual([{ project_id: 'worker-b', user_id: 'worker-user' }]);
  });
});

describe('failed erasure logging', () => {
  it('records a failed receipt without logging the subject', async () => {
    const user = 'logged-subject-user';
    const logs = [];
    const original = console.error;
    console.error = (...args) => {
      logs.push(args.map((part) => String(part)).join(' '));
    };
    try {
      const { handler, raw } = setup({
        deleteRows: async () => {
          throw new Error(`database locked while deleting ${user}`);
        },
      });
      insertEvent(raw, { id: 'keep', project: 'log-a', userId: user });
      insertEvent(raw, { id: 'keep-b', project: 'log-b', userId: user });
      const betaBefore = snapshot(raw, 'log-b');

      const failed = await erase(handler, {
        project: 'log-a',
        idempotency_key: 'log-key',
        confirm: 'erase',
        user_id: user,
      });
      expect(failed.status).toBe(200);
      expect(failed.data.status).toBe('failed');
      expect(failed.data.error).toBe('erasure failed');
      expect(failed.text).not.toContain(user);
      expect(countEvents(raw, 'log-a')).toBe(1);
      expect(snapshot(raw, 'log-b')).toEqual(betaBefore);
      expect(logs.join('\n')).not.toContain(user);
      expect(logs.join('\n')).toContain('Erasure failed');
    } finally {
      console.error = original;
    }
  });
});
