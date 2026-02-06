# Agent Analytics

Simple, self-hostable analytics for AI agents and web apps. Track events, query stats, zero dependencies on third-party analytics services.

**Deploy to Cloudflare Workers** (free tier works great) or **self-host with Node.js + SQLite**.

## Quick Start

### Cloudflare Workers (recommended)

```bash
# Clone
git clone https://github.com/Agent-Analytics/agent-analytics.git
cd agent-analytics

# Create D1 database
npx wrangler d1 create agent-analytics
# Update wrangler.toml with the database_id from output

# Initialize schema
npx wrangler d1 execute agent-analytics --file=./schema.sql

# Set your API key (for reading stats)
npx wrangler secret put API_KEYS
# Enter a comma-separated list of keys, e.g. "my-secret-key"

# Deploy
npx wrangler deploy
```

### Self-Hosted (Node.js)

```bash
git clone https://github.com/Agent-Analytics/agent-analytics.git
cd agent-analytics
npm install

# Run (SQLite database auto-created)
API_KEYS=my-secret-key npm start

# Or with options:
PORT=3000 DB_PATH=./data/analytics.db API_KEYS=key1,key2 npm start
```

## Try It Now

A live demo runs at `api.agentanalytics.sh`. Send a test event right from your terminal:

```bash
# 1. Track an event (no auth needed)
curl -X POST https://api.agentanalytics.sh/track \
  -H "Content-Type: application/json" \
  -d '{
    "project": "demo",
    "event": "hello_world",
    "properties": { "source": "readme" },
    "user_id": "test_user_1"
  }'
# → {"ok": true}

# 2. Track a batch
curl -X POST https://api.agentanalytics.sh/track/batch \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      { "project": "demo", "event": "signup", "user_id": "u1", "properties": { "plan": "free" } },
      { "project": "demo", "event": "signup", "user_id": "u2", "properties": { "plan": "pro" } }
    ]
  }'
# → {"ok": true, "count": 2}

# 3. Query your data (API key required for reads)
curl -X POST https://api.agentanalytics.sh/query \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{
    "project": "demo",
    "metrics": ["event_count", "unique_users"],
    "group_by": ["event"]
  }'
```

To get an API key for the hosted version, [contact us](https://agentanalytics.sh) or self-host for full control.

## Architecture

```
src/
  handlers.js          — Pure request handling (Web API Request/Response)
  auth.js              — API key validation
  tracker.js           — Embeddable client-side tracking script
  db/
    adapter.js         — Shared types and helpers
    d1.js              — Cloudflare D1 adapter
    sqlite.js          — better-sqlite3 adapter (self-host)
  platforms/
    cloudflare.js      — CF Worker entry (ctx.waitUntil for non-blocking writes)
    node.js            — Node.js HTTP server entry
```

Handlers are platform-agnostic. SQL lives in the database adapters. Platform entry points just wire things together.

## API Reference

### Track Events (no auth required)

#### `POST /track`

Track a single event.

```json
{
  "project": "my-app",
  "event": "page_view",
  "properties": { "page": "/home", "browser": "chrome" },
  "user_id": "user_123",
  "timestamp": 1706745600000
}
```

- `project` (required) — Project identifier
- `event` (required) — Event name
- `properties` (optional) — Arbitrary JSON properties
- `user_id` (optional) — User identifier
- `timestamp` (optional) — Unix ms timestamp (defaults to now)

#### `POST /track/batch`

Track up to 100 events at once.

```json
{
  "events": [
    { "project": "my-app", "event": "click", "user_id": "u1" },
    { "project": "my-app", "event": "scroll", "user_id": "u2" }
  ]
}
```

### Read Data (API key required)

Pass your key via `X-API-Key` header or `?key=` query parameter.

#### `GET /stats`

Aggregated stats for a project.

```
GET /stats?project=my-app&days=7&key=YOUR_KEY
```

Returns daily breakdown, event counts, and totals.

#### `GET /events`

Raw event log.

```
GET /events?project=my-app&event=page_view&days=7&limit=100&key=YOUR_KEY
```

#### `POST /query`

Flexible analytics query with metrics, filters, and grouping.

```json
{
  "project": "my-app",
  "metrics": ["event_count", "unique_users"],
  "group_by": ["event", "date"],
  "filters": [
    { "field": "event", "op": "eq", "value": "page_view" },
    { "field": "properties.browser", "op": "eq", "value": "chrome" }
  ],
  "date_from": "2025-01-01",
  "date_to": "2025-01-31",
  "order_by": "event_count",
  "order": "desc",
  "limit": 50
}
```

**Metrics:** `event_count`, `unique_users`  
**Group by:** `event`, `date`, `user_id`  
**Filter ops:** `eq`, `neq`, `gt`, `lt`, `gte`, `lte`  
**Filter fields:** `event`, `user_id`, `date`, `properties.*`

#### `GET /properties`

Discover event names and property keys for a project.

```
GET /properties?project=my-app&days=30&key=YOUR_KEY
```

### Utility

#### `GET /health`

Returns `{ "status": "ok", "service": "agent-analytics" }`.

#### `GET /tracker.js`

Client-side tracking script. Add to any web page:

```html
<script src="https://your-domain.com/tracker.js" data-project="my-app"></script>
```

Auto-tracks page views. Use `window.aa.track('event', { props })` for custom events.

## License

MIT
