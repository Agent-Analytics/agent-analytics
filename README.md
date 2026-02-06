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

# Set secrets
npx wrangler secret put API_KEYS          # Read key (for querying data)
npx wrangler secret put PROJECT_TOKENS    # Project token (for ingestion)

# Deploy
npx wrangler deploy
```

### Self-Hosted (Node.js)

```bash
git clone https://github.com/Agent-Analytics/agent-analytics.git
cd agent-analytics
npm install

# Run (SQLite database auto-created)
API_KEYS=my-secret-key PROJECT_TOKENS=pt_my-token npm start

# Or with options:
PORT=3000 DB_PATH=./data/analytics.db API_KEYS=key1,key2 PROJECT_TOKENS=pt_abc npm start
```

## Try It Now

Track an event from your terminal:

```bash
# 1. Track an event (token in body — no special headers)
curl -X POST https://api.agentanalytics.sh/track \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-app",
    "token": "YOUR_PROJECT_TOKEN",
    "event": "hello_world",
    "properties": { "source": "readme" },
    "user_id": "test_user_1"
  }'
# → {"ok": true}

# 2. Track a batch
curl -X POST https://api.agentanalytics.sh/track/batch \
  -H "Content-Type: application/json" \
  -d '{
    "token": "YOUR_PROJECT_TOKEN",
    "events": [
      { "project": "my-app", "event": "signup", "user_id": "u1", "properties": { "plan": "free" } },
      { "project": "my-app", "event": "signup", "user_id": "u2", "properties": { "plan": "pro" } }
    ]
  }'
# → {"ok": true, "count": 2}

# 3. Query your data (API key required for reads)
curl -X POST https://api.agentanalytics.sh/query \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "project": "my-app",
    "metrics": ["event_count", "unique_users"],
    "group_by": ["event"]
  }'
```

## Add to Your Website

Drop one line before `</body>`:

```html
<script src="https://api.agentanalytics.sh/tracker.js" data-project="my-app" data-token="YOUR_PROJECT_TOKEN"></script>
```

This auto-tracks page views with URL, referrer, and screen size. For custom events:

```javascript
// Track custom events
window.aa.track('button_click', { button: 'signup', page: '/pricing' });

// Identify a logged-in user
window.aa.identify('user_123');

// Manually track a page view
window.aa.page('Dashboard');
```

## Security

Two types of auth (same model as Mixpanel):

### Project Token (ingestion)

Public token embedded in client-side code. Passed in the **request body** — no custom headers, no CORS preflight, zero issues. Like Mixpanel's project token: identifies the project but isn't a secret.

```bash
npx wrangler secret put PROJECT_TOKENS    # Cloudflare
PROJECT_TOKENS=pt_abc123 npm start         # Self-hosted
```

If `PROJECT_TOKENS` isn't set, ingestion is open (dev/self-host mode).

### API Key (query/read)

Private key for reading data. Passed via `X-API-Key` header or `?key=` param. **Never expose in client code.**

```bash
npx wrangler secret put API_KEYS           # Cloudflare
API_KEYS=your-secret-key npm start          # Self-hosted
```

Required for: `/stats`, `/events`, `/query`, `/properties`.

## Architecture

```
src/
  handlers.js          — Pure request handling (Web API Request/Response)
  auth.js              — Token + API key validation
  tracker.js           — Embeddable client-side tracking script
  db/
    adapter.js         — Shared types and helpers
    d1.js              — Cloudflare D1 adapter
    sqlite.js          — better-sqlite3 adapter (self-host)
  platforms/
    cloudflare.js      — CF Worker entry (ctx.waitUntil for non-blocking writes)
    node.js            — Node.js HTTP server entry
```

Handlers are platform-agnostic. SQL lives in the database adapters. Platform entry points just wire things together. Add a new adapter to support any database.

## API Reference

### Ingestion (project token required)

#### `POST /track`

Track a single event.

```json
{
  "project": "my-app",
  "token": "pt_your_project_token",
  "event": "page_view",
  "properties": { "page": "/home", "browser": "chrome" },
  "user_id": "user_123",
  "timestamp": 1706745600000
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `project` | ✅ | Project identifier |
| `token` | ✅* | Project token (*optional if `PROJECT_TOKENS` not configured) |
| `event` | ✅ | Event name |
| `properties` | | Arbitrary JSON properties |
| `user_id` | | User identifier |
| `timestamp` | | Unix ms timestamp (defaults to now) |

#### `POST /track/batch`

Track up to 100 events at once. Token can be at the batch level or per-event.

```json
{
  "token": "pt_your_project_token",
  "events": [
    { "project": "my-app", "event": "click", "user_id": "u1" },
    { "project": "my-app", "event": "scroll", "user_id": "u2" }
  ]
}
```

### Query (API key required)

Pass your key via `X-API-Key` header or `?key=` query parameter.

#### `GET /stats`

Aggregated overview for a project.

```
GET /stats?project=my-app&days=7
```

Returns daily breakdown (unique users + total events), top events by count, and period totals.

#### `GET /events`

Raw event log with filters.

```
GET /events?project=my-app&event=page_view&days=7&limit=100
```

#### `POST /query`

Flexible analytics query — the power endpoint. Supports metrics, grouping, filtering, and sorting.

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

| Parameter | Description |
|-----------|-------------|
| `metrics` | `event_count`, `unique_users` |
| `group_by` | `event`, `date`, `user_id` |
| `filters[].op` | `eq`, `neq`, `gt`, `lt`, `gte`, `lte` |
| `filters[].field` | `event`, `user_id`, `date`, or `properties.*` for JSON property filters |
| `order_by` | Any metric or group_by field |
| `limit` | Max 1000 rows (default: 100) |

#### `GET /properties`

Discover event names and property keys for a project. Useful for building dynamic queries.

```
GET /properties?project=my-app&days=30
```

Returns event names with counts, first/last seen dates, and all known property keys.

### Utility

#### `GET /health`

```json
{ "status": "ok", "service": "agent-analytics" }
```

#### `GET /tracker.js`

Client-side tracking script. See [Add to Your Website](#add-to-your-website) above.

## License

MIT
