/**
 * Agent Analytics - Simple analytics for AI agents
 * Cloudflare Worker + D1
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // POST /track - ingest events (non-blocking write)
      if (path === '/track' && request.method === 'POST') {
        const body = await request.json();
        const { project, event, properties, user_id, timestamp } = body;

        if (!project || !event) {
          return jsonResponse({ error: 'project and event required' }, 400);
        }

        const ts = timestamp || Date.now();
        const date = new Date(ts).toISOString().split('T')[0];

        // Non-blocking write - respond immediately, persist in background
        ctx.waitUntil(
          env.DB.prepare(
            `INSERT INTO events (project_id, event, properties, user_id, timestamp, date)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
            .bind(
              project,
              event,
              properties ? JSON.stringify(properties) : null,
              user_id || null,
              ts,
              date
            )
            .run()
            .catch(err => console.error('Track write failed:', err))
        );

        // Instant response - don't wait for D1
        return jsonResponse({ ok: true });
      }

      // POST /track/batch - batch ingest (more efficient)
      if (path === '/track/batch' && request.method === 'POST') {
        const body = await request.json();
        const events = body.events || [];

        if (!Array.isArray(events) || events.length === 0) {
          return jsonResponse({ error: 'events array required' }, 400);
        }

        if (events.length > 100) {
          return jsonResponse({ error: 'max 100 events per batch' }, 400);
        }

        // Batch insert in background
        ctx.waitUntil(
          (async () => {
            const stmt = env.DB.prepare(
              `INSERT INTO events (project_id, event, properties, user_id, timestamp, date)
               VALUES (?, ?, ?, ?, ?, ?)`
            );
            const batch = events.map((e) => {
              const ts = e.timestamp || Date.now();
              const date = new Date(ts).toISOString().split('T')[0];
              return stmt.bind(
                e.project,
                e.event,
                e.properties ? JSON.stringify(e.properties) : null,
                e.user_id || null,
                ts,
                date
              );
            });
            await env.DB.batch(batch);
          })().catch(err => console.error('Batch write failed:', err))
        );

        return jsonResponse({ ok: true, count: events.length });
      }

      // GET /stats - aggregated stats (requires API key)
      if (path === '/stats' && request.method === 'GET') {
        const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('key');
        if (!env.API_KEYS || !apiKey || !env.API_KEYS.split(',').includes(apiKey)) {
          return jsonResponse({ error: 'unauthorized - API key required' }, 401);
        }

        const project = url.searchParams.get('project');
        const days = parseInt(url.searchParams.get('days') || '7');

        if (!project) {
          return jsonResponse({ error: 'project required' }, 400);
        }

        const fromDate = daysAgo(days);

        // Daily unique users
        const dailyUsers = await env.DB.prepare(
          `SELECT date, COUNT(DISTINCT user_id) as unique_users, COUNT(*) as total_events
           FROM events 
           WHERE project_id = ? AND date >= ?
           GROUP BY date
           ORDER BY date`
        )
          .bind(project, fromDate)
          .all();

        // Event breakdown
        const eventCounts = await env.DB.prepare(
          `SELECT event, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users
           FROM events 
           WHERE project_id = ? AND date >= ?
           GROUP BY event
           ORDER BY count DESC
           LIMIT 20`
        )
          .bind(project, fromDate)
          .all();

        // Totals
        const totals = await env.DB.prepare(
          `SELECT COUNT(DISTINCT user_id) as unique_users, COUNT(*) as total_events
           FROM events 
           WHERE project_id = ? AND date >= ?`
        )
          .bind(project, fromDate)
          .first();

        return jsonResponse({
          project,
          period: { from: fromDate, to: today(), days },
          totals,
          daily: dailyUsers.results,
          events: eventCounts.results,
        });
      }

      // GET /events - raw events query (requires API key)
      if (path === '/events' && request.method === 'GET') {
        const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('key');
        if (!env.API_KEYS || !apiKey || !env.API_KEYS.split(',').includes(apiKey)) {
          return jsonResponse({ error: 'unauthorized - API key required' }, 401);
        }

        const project = url.searchParams.get('project');
        const event = url.searchParams.get('event');
        const days = parseInt(url.searchParams.get('days') || '7');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 1000);

        if (!project) {
          return jsonResponse({ error: 'project required' }, 400);
        }

        const fromDate = daysAgo(days);

        let query = `SELECT * FROM events WHERE project_id = ? AND date >= ?`;
        const params = [project, fromDate];

        if (event) {
          query += ` AND event = ?`;
          params.push(event);
        }

        query += ` ORDER BY timestamp DESC LIMIT ?`;
        params.push(limit);

        const events = await env.DB.prepare(query).bind(...params).all();

        // Parse properties JSON
        const results = events.results.map((e) => ({
          ...e,
          properties: e.properties ? JSON.parse(e.properties) : null,
        }));

        return jsonResponse({ project, events: results });
      }

      // POST /query - flexible analytics query (non-blocking reads)
      if (path === '/query' && request.method === 'POST') {
        const apiKey = request.headers.get('X-API-Key');
        if (!env.API_KEYS || !apiKey || !env.API_KEYS.split(',').includes(apiKey)) {
          return jsonResponse({ error: 'unauthorized - API key required' }, 401);
        }

        const body = await request.json();
        const { project, metrics, filters, date_from, date_to, group_by, order_by, order, limit: queryLimit } = body;

        if (!project) {
          return jsonResponse({ error: 'project required' }, 400);
        }

        // Validate metrics
        const ALLOWED_METRICS = ['event_count', 'unique_users'];
        const requestedMetrics = metrics || ['event_count'];
        for (const m of requestedMetrics) {
          if (!ALLOWED_METRICS.includes(m)) {
            return jsonResponse({ error: `invalid metric: ${m}. allowed: ${ALLOWED_METRICS.join(', ')}` }, 400);
          }
        }

        // Validate group_by
        const ALLOWED_GROUP_BY = ['event', 'date', 'user_id'];
        const groupBy = group_by || [];
        for (const g of groupBy) {
          if (!ALLOWED_GROUP_BY.includes(g)) {
            return jsonResponse({ error: `invalid group_by: ${g}. allowed: ${ALLOWED_GROUP_BY.join(', ')}` }, 400);
          }
        }

        // Build SELECT clause
        const selectParts = [];
        if (groupBy.length > 0) {
          selectParts.push(...groupBy);
        }
        for (const m of requestedMetrics) {
          if (m === 'event_count') selectParts.push('COUNT(*) as event_count');
          if (m === 'unique_users') selectParts.push('COUNT(DISTINCT user_id) as unique_users');
        }
        if (selectParts.length === 0) selectParts.push('COUNT(*) as event_count');

        // Build WHERE clause
        const whereParts = ['project_id = ?'];
        const params = [project];

        const fromDate = date_from || daysAgo(7);
        const toDate = date_to || today();
        whereParts.push('date >= ?', 'date <= ?');
        params.push(fromDate, toDate);

        // Apply filters
        if (filters && Array.isArray(filters)) {
          const FILTER_OPS = { eq: '=', neq: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=' };
          const FILTERABLE_FIELDS = ['event', 'user_id', 'date'];

          for (const f of filters) {
            if (!f.field || !f.op || f.value === undefined) continue;

            if (FILTERABLE_FIELDS.includes(f.field)) {
              const sqlOp = FILTER_OPS[f.op];
              if (!sqlOp) {
                return jsonResponse({ error: `invalid filter op: ${f.op}. allowed: ${Object.keys(FILTER_OPS).join(', ')}` }, 400);
              }
              whereParts.push(`${f.field} ${sqlOp} ?`);
              params.push(f.value);
            } else if (f.field.startsWith('properties.')) {
              // JSON property filter via json_extract
              const propKey = f.field.replace('properties.', '');
              const sqlOp = FILTER_OPS[f.op];
              if (!sqlOp) continue;
              whereParts.push(`json_extract(properties, '$.${propKey}') ${sqlOp} ?`);
              params.push(f.value);
            }
          }
        }

        let query = `SELECT ${selectParts.join(', ')} FROM events WHERE ${whereParts.join(' AND ')}`;

        if (groupBy.length > 0) {
          query += ` GROUP BY ${groupBy.join(', ')}`;
        }

        // ORDER BY
        const ALLOWED_ORDER = ['event_count', 'unique_users', 'date', 'event'];
        const orderField = order_by && ALLOWED_ORDER.includes(order_by) ? order_by : (groupBy.includes('date') ? 'date' : 'event_count');
        const orderDir = order === 'asc' ? 'ASC' : 'DESC';
        query += ` ORDER BY ${orderField} ${orderDir}`;

        const maxLimit = Math.min(parseInt(queryLimit) || 100, 1000);
        query += ` LIMIT ?`;
        params.push(maxLimit);

        const result = await env.DB.prepare(query).bind(...params).all();

        return jsonResponse({
          project,
          period: { from: fromDate, to: toDate },
          metrics: requestedMetrics,
          group_by: groupBy,
          rows: result.results,
          count: result.results.length,
        });
      }

      // GET /properties - discover event names and property keys
      if (path === '/properties' && request.method === 'GET') {
        const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('key');
        if (!env.API_KEYS || !apiKey || !env.API_KEYS.split(',').includes(apiKey)) {
          return jsonResponse({ error: 'unauthorized - API key required' }, 401);
        }

        const project = url.searchParams.get('project');
        if (!project) {
          return jsonResponse({ error: 'project required' }, 400);
        }

        const days = parseInt(url.searchParams.get('days') || '30');
        const fromDate = daysAgo(days);

        // Get event names with counts
        const events = await env.DB.prepare(
          `SELECT event, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users,
                  MIN(date) as first_seen, MAX(date) as last_seen
           FROM events WHERE project_id = ? AND date >= ?
           GROUP BY event ORDER BY count DESC`
        ).bind(project, fromDate).all();

        // Sample property keys from recent events (top 100)
        const sample = await env.DB.prepare(
          `SELECT DISTINCT properties FROM events 
           WHERE project_id = ? AND properties IS NOT NULL AND date >= ?
           ORDER BY timestamp DESC LIMIT 100`
        ).bind(project, fromDate).all();

        const propKeys = new Set();
        for (const row of sample.results) {
          try {
            const props = JSON.parse(row.properties);
            Object.keys(props).forEach(k => propKeys.add(k));
          } catch (e) {}
        }

        return jsonResponse({
          project,
          events: events.results,
          property_keys: [...propKeys].sort(),
        });
      }

      // GET /health
      if (path === '/health') {
        return jsonResponse({ status: 'ok', service: 'agent-analytics' });
      }

      // Serve tracker.js
      if (path === '/tracker.js') {
        return new Response(TRACKER_JS, {
          headers: { 'Content-Type': 'application/javascript', ...CORS_HEADERS },
        });
      }

      // 404
      return jsonResponse({ error: 'not found' }, 404);

    } catch (err) {
      console.error('Error:', err);
      return jsonResponse({ error: err.message }, 500);
    }
  },
};

// Embedded tracker.js
const TRACKER_JS = `
(function() {
  'use strict';
  
  const ENDPOINT = (document.currentScript && document.currentScript.src) 
    ? new URL(document.currentScript.src).origin + '/track'
    : '/track';
  
  const PROJECT = (document.currentScript && document.currentScript.dataset.project) || 'default';
  
  // Simple fingerprint for anonymous users
  function getAnonId() {
    let id = localStorage.getItem('aa_uid');
    if (!id) {
      id = 'anon_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
      localStorage.setItem('aa_uid', id);
    }
    return id;
  }
  
  let userId = getAnonId();
  
  const aa = {
    track: function(event, properties) {
      const payload = {
        project: PROJECT,
        event: event,
        properties: {
          ...properties,
          url: location.href,
          referrer: document.referrer,
          screen: screen.width + 'x' + screen.height,
        },
        user_id: userId,
        timestamp: Date.now()
      };
      
      // Use sendBeacon for reliability, fallback to fetch
      const data = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, data);
      } else {
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: data,
          keepalive: true
        }).catch(() => {});
      }
    },
    
    identify: function(id) {
      userId = id;
      localStorage.setItem('aa_uid', id);
    },
    
    page: function(name) {
      this.track('page_view', { page: name || document.title, path: location.pathname });
    }
  };
  
  // Auto track page view
  aa.page();
  
  // Expose globally
  window.aa = aa;
})();
`;

