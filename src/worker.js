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
