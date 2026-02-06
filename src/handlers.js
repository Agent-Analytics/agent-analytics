/**
 * Pure request handlers — no platform-specific code
 * 
 * Uses standard Web API Request/Response objects.
 * All database access goes through the db adapter.
 * All auth goes through auth.js.
 * 
 * Each handler returns { response, writeOps? } where writeOps
 * is an array of Promises the platform can fire-and-forget
 * (e.g. ctx.waitUntil on Cloudflare).
 */

import { validateApiKey, validateProjectToken } from './auth.js';
import { TRACKER_JS } from './tracker.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/**
 * Route a request to the appropriate handler.
 * @param {Request} request
 * @param {import('./db/adapter.js').DbAdapter} db
 * @param {string} apiKeys - Comma-separated read API keys from env
 * @param {{ projectTokens?: string }} opts - Project token config
 * @returns {Promise<{ response: Response, writeOps?: Promise[] }>}
 */
export async function handleRequest(request, db, apiKeys, opts = {}) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return { response: new Response(null, { headers: CORS_HEADERS }) };
  }

  try {
    // POST /track
    if (path === '/track' && request.method === 'POST') {
      return await handleTrack(request, db, opts.projectTokens);
    }

    // POST /track/batch
    if (path === '/track/batch' && request.method === 'POST') {
      return await handleTrackBatch(request, db, opts.projectTokens);
    }

    // GET /stats
    if (path === '/stats' && request.method === 'GET') {
      return await handleStats(request, url, db, apiKeys);
    }

    // GET /events
    if (path === '/events' && request.method === 'GET') {
      return await handleEvents(request, url, db, apiKeys);
    }

    // POST /query
    if (path === '/query' && request.method === 'POST') {
      return await handleQuery(request, db, apiKeys);
    }

    // GET /properties
    if (path === '/properties' && request.method === 'GET') {
      return await handleProperties(request, url, db, apiKeys);
    }

    // GET /health
    if (path === '/health') {
      return { response: json({ status: 'ok', service: 'agent-analytics' }) };
    }

    // GET /tracker.js
    if (path === '/tracker.js') {
      return {
        response: new Response(TRACKER_JS, {
          headers: { 'Content-Type': 'application/javascript', ...CORS_HEADERS },
        }),
      };
    }

    return { response: json({ error: 'not found' }, 404) };
  } catch (err) {
    console.error('Error:', err);
    return { response: json({ error: err.message }, 500) };
  }
}

// --- Individual handlers ---

async function handleTrack(request, db, projectTokens) {
  const body = await request.json();
  const { project, event, properties, user_id, timestamp, token } = body;

  if (!project || !event) {
    return { response: json({ error: 'project and event required' }, 400) };
  }

  const tokenAuth = validateProjectToken(token, projectTokens);
  if (!tokenAuth.valid) {
    return { response: json({ error: tokenAuth.error }, 403) };
  }

  const writeOp = db.trackEvent({ project, event, properties, user_id, timestamp })
    .catch(err => console.error('Track write failed:', err));

  return { response: json({ ok: true }), writeOps: [writeOp] };
}

async function handleTrackBatch(request, db, projectTokens) {
  const body = await request.json();
  const { events, token } = body;

  if (!Array.isArray(events) || events.length === 0) {
    return { response: json({ error: 'events array required' }, 400) };
  }
  if (events.length > 100) {
    return { response: json({ error: 'max 100 events per batch' }, 400) };
  }

  // Token can be at batch level or per-event (batch level takes precedence)
  const batchToken = token || (events[0] && events[0].token);
  const tokenAuth = validateProjectToken(batchToken, projectTokens);
  if (!tokenAuth.valid) {
    return { response: json({ error: tokenAuth.error }, 403) };
  }

  const writeOp = db.trackBatch(events)
    .catch(err => console.error('Batch write failed:', err));

  return { response: json({ ok: true, count: events.length }), writeOps: [writeOp] };
}

async function handleStats(request, url, db, apiKeys) {
  if (!validateApiKey(request, url, apiKeys).valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const project = url.searchParams.get('project');
  if (!project) return { response: json({ error: 'project required' }, 400) };

  const days = parseInt(url.searchParams.get('days') || '7');
  const stats = await db.getStats({ project, days });

  return { response: json({ project, ...stats }) };
}

async function handleEvents(request, url, db, apiKeys) {
  if (!validateApiKey(request, url, apiKeys).valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const project = url.searchParams.get('project');
  if (!project) return { response: json({ error: 'project required' }, 400) };

  const event = url.searchParams.get('event');
  const days = parseInt(url.searchParams.get('days') || '7');
  const limit = parseInt(url.searchParams.get('limit') || '100');

  const events = await db.getEvents({ project, event, days, limit });
  return { response: json({ project, events }) };
}

async function handleQuery(request, db, apiKeys) {
  const url = new URL(request.url);
  if (!validateApiKey(request, url, apiKeys).valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const body = await request.json();
  if (!body.project) return { response: json({ error: 'project required' }, 400) };

  try {
    const result = await db.query(body);
    return { response: json({ project: body.project, ...result }) };
  } catch (err) {
    return { response: json({ error: err.message }, 400) };
  }
}

async function handleProperties(request, url, db, apiKeys) {
  if (!validateApiKey(request, url, apiKeys).valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const project = url.searchParams.get('project');
  if (!project) return { response: json({ error: 'project required' }, 400) };

  const days = parseInt(url.searchParams.get('days') || '30');
  const result = await db.getProperties({ project, days });

  return { response: json({ project, ...result }) };
}
