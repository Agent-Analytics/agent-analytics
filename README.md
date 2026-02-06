# Agent Analytics

Simple, self-hostable web analytics that your AI agent can read. Same idea as Google Analytics — add a JS snippet to your site — but with an API your agent queries instead of dashboards you'll never open.

**Deploy to Cloudflare Workers** (free tier works great) or **self-host with Node.js + SQLite**.

## Quick Start

### Cloudflare Workers (recommended)

```bash
# 1. Clone
git clone https://github.com/Agent-Analytics/agent-analytics.git
cd agent-analytics

# 2. Create a D1 database
npx wrangler d1 create agent-analytics
```

This outputs something like:

```
database_name = "agent-analytics"
database_id = "abc123-your-id-here"
```

**Update `wrangler.toml`** with your `database_id` (and optionally your `account_id`). The binding must stay as `DB`.

```bash
# 3. Initialize the schema (note: --remote is required!)
npx wrangler d1 execute agent-analytics --remote --file=./schema.sql

# 4. Set secrets
echo "your-secret-read-key" | npx wrangler secret put API_KEYS
echo "pt_your-project-token" | npx wrangler secret put PROJECT_TOKENS

# 5. Deploy
npx wrangler deploy
```

That's it. You'll get a URL like `https://agent-analytics.YOUR-SUBDOMAIN.workers.dev`.

#### Optional: Enable Queue (recommended for production)

By default, events write directly to D1. For higher throughput and automatic retries, enable Cloudflare Queues:

```bash
# Create the queue
npx wrangler queues create agent-analytics-events
```

Then uncomment the `[[queues.producers]]` and `[[queues.consumers]]` sections in `wrangler.toml` and redeploy:

```bash
npx wrangler deploy
```

With queues enabled, `/track` responds instantly and events are batch-written to D1 asynchronously (up to 100 events per batch, flushed every 5 seconds). The API is identical — no client-side changes needed.

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

## Add to Your Website

Drop one line before `</body>` — just like Google Analytics:

```html
<script src="https://your-analytics-url.com/tracker.js" data-project="my-site" data-token="YOUR_PROJECT_TOKEN"></script>
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

## Your Agent Reads the Data

The whole point: your AI assistant queries the API instead of you logging into a dashboard.

```bash
# Your agent runs this:
curl "https://your-analytics-url.com/stats?project=my-site&days=7" \
  -H "X-API-Key: YOUR_API_KEY"
```

Response:
```json
{
  "totals": { "unique_users": 1203, "total_events": 4821 },
  "events": [
    { "event": "page_view", "count": 3920 },
    { "event": "signup_click", "count": 127 }
  ]
}
```

Your agent turns that into: *"4,821 pageviews from 1,203 unique visitors this week, up 23% from last week. 127 signup clicks at 2.6% conversion."*

## Security

Two types of auth — same model as Mixpanel:

### Project Token (ingestion)

Public token embedded in client-side code. Passed in the **request body** — no custom headers needed, no CORS preflight. Like Mixpanel's project token: identifies the project but isn't a secret.

```bash
echo "pt_your-token" | npx wrangler secret put PROJECT_TOKENS    # Cloudflare
PROJECT_TOKENS=pt_abc123 npm start                                 # Self-hosted
```

If `PROJECT_TOKENS` isn't set, ingestion is open (good for dev/self-host).

### API Key (query/read)

Private key for reading data. Passed via `X-API-Key` header or `?key=` param. **Never expose in client code.**

```bash
echo "your-secret-key" | npx wrangler secret put API_KEYS    # Cloudflare
API_KEYS=your-secret-key npm start                             # Self-hosted
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
    cloudflare.js      — CF Worker entry (Queue + ctx.waitUntil)
    node.js            — Node.js HTTP server entry
```

Handlers are platform-agnostic — they return data and let the platform decide how to write it. On Cloudflare, writes go through a Queue (if configured) or `ctx.waitUntil`. On Node.js, writes are inline. Add a new adapter to support any database or platform.

## API Reference

### Ingestion (project token required)

#### `POST /track`

Track a single event.

```json
{
  "project": "my-site",
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
    { "project": "my-site", "event": "click", "user_id": "u1" },
    { "project": "my-site", "event": "scroll", "user_id": "u2" }
  ]
}
```

### Query (API key required)

Pass your key via `X-API-Key` header or `?key=` query parameter.

#### `GET /stats`

Aggregated overview for a project.

```
GET /stats?project=my-site&days=7
```

Returns daily breakdown (unique users + total events), top events by count, and period totals.

#### `GET /events`

Raw event log with filters.

```
GET /events?project=my-site&event=page_view&days=7&limit=100
```

#### `POST /query`

Flexible analytics query — the power endpoint. Supports metrics, grouping, filtering, and sorting.

```json
{
  "project": "my-site",
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
GET /properties?project=my-site&days=30
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
