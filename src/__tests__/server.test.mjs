/**
 * Integration tests for the open-source self-hosted server.
 *
 * Uses SqliteAdapter with :memory: DB + createAnalyticsHandler from core.
 * Tests every endpoint the handler exposes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createAnalyticsHandler } from '@agent-analytics/core';
import { SqliteAdapter } from '../db/sqlite.js';
import { makeValidateWrite, makeValidateRead } from '../auth.js';

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

function postJSON(path, body) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(path, headers = {}) {
  return new Request(`http://localhost${path}`, { headers });
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

describe('GET /sessions', () => {
  it('returns sessions for project', async () => {
    const { response } = await handler(get(`/sessions?project=${PROJECT}`, authHeaders));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBe(PROJECT);
    expect(Array.isArray(data.sessions)).toBe(true);
    expect(data.sessions.length).toBeGreaterThan(0);
  });

  it('rejects without API key', async () => {
    const { response } = await handler(get(`/sessions?project=${PROJECT}`));
    expect(response.status).toBe(401);
  });

  it('rejects without project param', async () => {
    const { response } = await handler(get('/sessions', authHeaders));
    expect(response.status).toBe(400);
  });
});

describe('POST /query', () => {
  it('returns query results', async () => {
    const req = postJSON('/query', {
      project: PROJECT,
      metrics: ['event_count', 'unique_users'],
      group_by: ['event'],
    });
    req.headers.set('X-API-Key', API_KEY);

    const { response } = await handler(req);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBe(PROJECT);
    expect(data.rows).toBeDefined();
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.count).toBeGreaterThan(0);
  });

  it('supports filters', async () => {
    const req = postJSON('/query', {
      project: PROJECT,
      metrics: ['event_count'],
      filters: [{ field: 'event', op: 'eq', value: 'page_view' }],
    });
    req.headers.set('X-API-Key', API_KEY);

    const { response } = await handler(req);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.rows).toBeDefined();
  });

  it('supports property filters', async () => {
    const req = postJSON('/query', {
      project: PROJECT,
      metrics: ['event_count'],
      filters: [{ field: 'properties.path', op: 'eq', value: '/home' }],
    });
    req.headers.set('X-API-Key', API_KEY);

    const { response } = await handler(req);
    expect(response.status).toBe(200);
  });

  it('rejects without API key', async () => {
    const { response } = await handler(postJSON('/query', { project: PROJECT }));
    expect(response.status).toBe(401);
  });

  it('rejects without project', async () => {
    const req = postJSON('/query', { metrics: ['event_count'] });
    req.headers.set('X-API-Key', API_KEY);
    const { response } = await handler(req);
    expect(response.status).toBe(400);
  });

  it('rejects invalid metric', async () => {
    const req = postJSON('/query', {
      project: PROJECT,
      metrics: ['bogus'],
    });
    req.headers.set('X-API-Key', API_KEY);
    const { response } = await handler(req);
    expect(response.status).toBe(400);
  });
});

describe('GET /properties', () => {
  it('returns event names and property keys', async () => {
    const { response } = await handler(get(`/properties?project=${PROJECT}`, authHeaders));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBe(PROJECT);
    expect(Array.isArray(data.events)).toBe(true);
    expect(data.events.length).toBeGreaterThan(0);
    expect(Array.isArray(data.property_keys)).toBe(true);
    expect(data.property_keys).toContain('path');
  });

  it('rejects without API key', async () => {
    const { response } = await handler(get(`/properties?project=${PROJECT}`));
    expect(response.status).toBe(401);
  });

  it('rejects without project param', async () => {
    const { response } = await handler(get('/properties', authHeaders));
    expect(response.status).toBe(400);
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
    expect(data.projects[0].id).toBe(PROJECT);
  });

  it('rejects without API key', async () => {
    const { response } = await handler(get('/projects'));
    expect(response.status).toBe(401);
  });
});
