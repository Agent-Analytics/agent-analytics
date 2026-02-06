/**
 * Pure request handlers — multi-tenant
 *
 * Each handler returns { response, writeOps? } where writeOps
 * is an array of Promises the platform can fire-and-forget.
 */

import { validateApiKey, validateProjectToken, generateToken, generateId } from './auth.js';
import { TRACKER_JS } from './tracker.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Admin-Key',
  'Access-Control-Allow-Credentials': 'false',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// In-memory project cache (per isolate, refreshed periodically)
let projectsCache = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

async function getProjectsCache(db) {
  const now = Date.now();
  if (!projectsCache || now - cacheLoadedAt > CACHE_TTL_MS) {
    try {
      projectsCache = await db.loadProjectsCache();
      cacheLoadedAt = now;
    } catch (e) {
      // If projects table doesn't exist yet, return empty cache
      if (e.message && e.message.includes('no such table')) {
        projectsCache = new Map();
        cacheLoadedAt = now;
      } else {
        throw e;
      }
    }
  }
  return projectsCache;
}

function invalidateCache() {
  projectsCache = null;
  cacheLoadedAt = 0;
}

/**
 * Route a request to the appropriate handler.
 */
export async function handleRequest(request, db, apiKeys, opts = {}) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return { response: new Response(null, { headers: CORS_HEADERS }) };
  }

  // Load project cache for auth
  const cache = await getProjectsCache(db);
  const authCtx = { projectsCache: cache };

  try {
    // ==================== PROJECT MANAGEMENT ====================

    // POST /projects — create a new project
    if (path === '/projects' && request.method === 'POST') {
      return await handleCreateProject(request, db, opts);
    }

    // GET /projects — list projects by owner
    if (path === '/projects' && request.method === 'GET') {
      return await handleListProjects(request, url, db, apiKeys, authCtx);
    }

    // GET /projects/:id
    if (path.match(/^\/projects\/[^/]+$/) && request.method === 'GET') {
      const id = path.split('/')[2];
      return await handleGetProject(request, url, db, apiKeys, authCtx, id);
    }

    // DELETE /projects/:id
    if (path.match(/^\/projects\/[^/]+$/) && request.method === 'DELETE') {
      const id = path.split('/')[2];
      return await handleDeleteProject(request, url, db, apiKeys, authCtx, id);
    }

    // GET /projects/:id/usage
    if (path.match(/^\/projects\/[^/]+\/usage$/) && request.method === 'GET') {
      const id = path.split('/')[2];
      return await handleProjectUsage(request, url, db, apiKeys, authCtx, id);
    }

    // ==================== TRACKING ====================

    // POST /track
    if (path === '/track' && request.method === 'POST') {
      return await handleTrack(request, db, opts.projectTokens, authCtx);
    }

    // POST /track/batch
    if (path === '/track/batch' && request.method === 'POST') {
      return await handleTrackBatch(request, db, opts.projectTokens, authCtx);
    }

    // ==================== READS ====================

    // GET /stats
    if (path === '/stats' && request.method === 'GET') {
      return await handleStats(request, url, db, apiKeys, authCtx);
    }

    // GET /events
    if (path === '/events' && request.method === 'GET') {
      return await handleEvents(request, url, db, apiKeys, authCtx);
    }

    // POST /query
    if (path === '/query' && request.method === 'POST') {
      return await handleQuery(request, db, apiKeys, authCtx);
    }

    // GET /properties
    if (path === '/properties' && request.method === 'GET') {
      return await handleProperties(request, url, db, apiKeys, authCtx);
    }

    // ==================== UTILITY ====================

    if (path === '/health') {
      return { response: json({ status: 'ok', service: 'agent-analytics', multi_tenant: true }) };
    }

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

// ==================== PROJECT HANDLERS ====================

async function handleCreateProject(request, db, opts) {
  const body = await request.json();
  const { name, email, allowed_origins } = body;

  if (!name || !email) {
    return { response: json({ error: 'name and email required' }, 400) };
  }

  // Check project limit for this email (free tier = 3)
  const existing = await db.listProjectsByOwner(email);
  if (existing.length >= 3) {
    return { response: json({ error: 'project limit reached (3 for free tier). Contact us for more.' }, 403) };
  }

  const id = generateId();
  const project_token = generateToken('aat');
  const api_key = generateToken('aak');

  const project = await db.createProject({
    id,
    name,
    owner_email: email,
    project_token,
    api_key,
    allowed_origins: allowed_origins || '*',
  });

  invalidateCache();

  return {
    response: json({
      id: project.id,
      name: project.name,
      project_token: project.project_token,
      api_key: project.api_key,
      allowed_origins: project.allowed_origins,
      tier: project.tier,
      snippet: `<script src="https://api.agentanalytics.sh/tracker.js" data-project="${project.name}" data-token="${project.project_token}"></script>`,
      api_example: `curl "https://api.agentanalytics.sh/stats?project=${project.name}&days=7" -H "X-API-Key: ${project.api_key}"`,
    }, 201),
  };
}

async function handleListProjects(request, url, db, apiKeys, authCtx) {
  const email = url.searchParams.get('email');

  // Auth: require admin key or valid API key
  const auth = validateApiKey(request, url, apiKeys, authCtx);
  if (!auth.valid && !email) {
    return { response: json({ error: 'unauthorized — API key or email required' }, 401) };
  }

  // If auth via API key, scope to that project's owner
  let ownerEmail = email;
  if (auth.valid && auth.project) {
    ownerEmail = ownerEmail || auth.project.owner_email;
  }

  if (!ownerEmail) {
    return { response: json({ error: 'email parameter required' }, 400) };
  }

  const projects = await db.listProjectsByOwner(ownerEmail);
  return { response: json({ projects }) };
}

async function handleGetProject(request, url, db, apiKeys, authCtx, id) {
  const auth = validateApiKey(request, url, apiKeys, authCtx);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized' }, 401) };
  }

  const project = await db.getProjectById(id);
  if (!project) return { response: json({ error: 'project not found' }, 404) };

  // If auth is from a specific project's API key, only allow viewing own project
  if (auth.project && auth.project.id !== id && auth.project.owner_email !== project.owner_email) {
    return { response: json({ error: 'forbidden' }, 403) };
  }

  const usage = await db.getUsageToday(id);

  return {
    response: json({
      ...project,
      usage_today: usage,
    }),
  };
}

async function handleDeleteProject(request, url, db, apiKeys, authCtx, id) {
  const auth = validateApiKey(request, url, apiKeys, authCtx);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized' }, 401) };
  }

  const project = await db.getProjectById(id);
  if (!project) return { response: json({ error: 'project not found' }, 404) };

  if (auth.project && auth.project.owner_email !== project.owner_email) {
    return { response: json({ error: 'forbidden' }, 403) };
  }

  await db.deleteProject(id);
  invalidateCache();

  return { response: json({ ok: true, deleted: id }) };
}

async function handleProjectUsage(request, url, db, apiKeys, authCtx, id) {
  const auth = validateApiKey(request, url, apiKeys, authCtx);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized' }, 401) };
  }

  const days = parseInt(url.searchParams.get('days') || '30');
  const usage = await db.getUsageHistory(id, days);

  return { response: json({ project_id: id, usage }) };
}

// ==================== TRACKING HANDLERS ====================

async function handleTrack(request, db, projectTokensStr, authCtx) {
  const body = await request.json();
  const { project, event, properties, user_id, timestamp, token } = body;

  if (!project || !event) {
    return { response: json({ error: 'project and event required' }, 400) };
  }

  const tokenAuth = validateProjectToken(token, projectTokensStr, authCtx);
  if (!tokenAuth.valid) {
    return { response: json({ error: tokenAuth.error }, 403) };
  }

  // Check rate limit if multi-tenant project
  if (tokenAuth.project) {
    const usage = await db.getUsageToday(tokenAuth.project.id);
    if (usage.event_count >= tokenAuth.project.rate_limit_events) {
      return {
        response: json({ error: 'rate limit exceeded', limit: tokenAuth.project.rate_limit_events }, 429),
      };
    }
  }

  const writeOps = [
    db.trackEvent({ project, event, properties, user_id, timestamp })
      .catch(err => console.error('Track write failed:', err)),
  ];

  // Track usage for multi-tenant projects
  if (tokenAuth.project) {
    writeOps.push(
      db.incrementUsage(tokenAuth.project.id, 'event')
        .catch(err => console.error('Usage increment failed:', err))
    );
  }

  return { response: json({ ok: true }), writeOps };
}

async function handleTrackBatch(request, db, projectTokensStr, authCtx) {
  const body = await request.json();
  const { events, token } = body;

  if (!Array.isArray(events) || events.length === 0) {
    return { response: json({ error: 'events array required' }, 400) };
  }
  if (events.length > 100) {
    return { response: json({ error: 'max 100 events per batch' }, 400) };
  }

  const batchToken = token || (events[0] && events[0].token);
  const tokenAuth = validateProjectToken(batchToken, projectTokensStr, authCtx);
  if (!tokenAuth.valid) {
    return { response: json({ error: tokenAuth.error }, 403) };
  }

  const writeOps = [
    db.trackBatch(events)
      .catch(err => console.error('Batch write failed:', err)),
  ];

  // Increment usage by batch size
  if (tokenAuth.project) {
    // We do a simple increment per event in the batch
    for (let i = 0; i < events.length; i++) {
      writeOps.push(
        db.incrementUsage(tokenAuth.project.id, 'event')
          .catch(err => console.error('Usage increment failed:', err))
      );
    }
  }

  return { response: json({ ok: true, count: events.length }), writeOps };
}

// ==================== READ HANDLERS ====================

async function handleStats(request, url, db, apiKeys, authCtx) {
  const auth = validateApiKey(request, url, apiKeys, authCtx);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const project = url.searchParams.get('project');
  if (!project) return { response: json({ error: 'project required' }, 400) };

  const days = parseInt(url.searchParams.get('days') || '7');
  const stats = await db.getStats({ project, days });

  // Track read usage
  const writeOps = [];
  if (auth.project) {
    writeOps.push(db.incrementUsage(auth.project.id, 'read').catch(() => {}));
  }

  return { response: json({ project, ...stats }), writeOps };
}

async function handleEvents(request, url, db, apiKeys, authCtx) {
  const auth = validateApiKey(request, url, apiKeys, authCtx);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const project = url.searchParams.get('project');
  if (!project) return { response: json({ error: 'project required' }, 400) };

  const event = url.searchParams.get('event');
  const days = parseInt(url.searchParams.get('days') || '7');
  const limit = parseInt(url.searchParams.get('limit') || '100');

  const events = await db.getEvents({ project, event, days, limit });

  const writeOps = [];
  if (auth.project) {
    writeOps.push(db.incrementUsage(auth.project.id, 'read').catch(() => {}));
  }

  return { response: json({ project, events }), writeOps };
}

async function handleQuery(request, db, apiKeys, authCtx) {
  const url = new URL(request.url);
  const auth = validateApiKey(request, url, apiKeys, authCtx);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const body = await request.json();
  if (!body.project) return { response: json({ error: 'project required' }, 400) };

  try {
    const result = await db.query(body);
    const writeOps = [];
    if (auth.project) {
      writeOps.push(db.incrementUsage(auth.project.id, 'read').catch(() => {}));
    }
    return { response: json({ project: body.project, ...result }), writeOps };
  } catch (err) {
    return { response: json({ error: err.message }, 400) };
  }
}

async function handleProperties(request, url, db, apiKeys, authCtx) {
  const auth = validateApiKey(request, url, apiKeys, authCtx);
  if (!auth.valid) {
    return { response: json({ error: 'unauthorized - API key required' }, 401) };
  }

  const project = url.searchParams.get('project');
  if (!project) return { response: json({ error: 'project required' }, 400) };

  const days = parseInt(url.searchParams.get('days') || '30');
  const result = await db.getProperties({ project, days });

  const writeOps = [];
  if (auth.project) {
    writeOps.push(db.incrementUsage(auth.project.id, 'read').catch(() => {}));
  }

  return { response: json({ project, ...result }), writeOps };
}
