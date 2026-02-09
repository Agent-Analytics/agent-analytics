# Agent Analytics

Web analytics your AI agent can read. Same idea as Google Analytics — add a JS snippet to your site — but instead of dashboards, your agent queries the data via CLI or API.

## Quick Start

### 1. Sign Up & Login

```bash
# Hosted (at app.agentanalytics.sh)
npx agent-analytics login --token aak_your_key

# Self-hosted — point to your instance
npx agent-analytics login --token your_key --url https://your-worker.dev
```

### 2. Create a Project

```bash
npx agent-analytics init my-site --domain https://mysite.com
# → Project created!
# → Token: pt_abc123...
# → Snippet + API example shown automatically
```

### 3. Add Tracking to Your Site

Drop one line before `</body>` — just like Google Analytics:

```html
<script src="https://api.agentanalytics.sh/tracker.js" data-project="my-site" data-token="pt_abc123"></script>
```

This auto-tracks page views with URL, referrer, and screen size. For custom events:

```javascript
window.aa.track('signup_click', { plan: 'pro', page: '/pricing' });
window.aa.identify('user_123');
window.aa.page('Dashboard');
```

**Framework guides:**
- **Plain HTML** — add before `</body>` of `index.html`
- **React/Next.js** — add to `_document.tsx` or `layout.tsx` via `<Script>`
- **Vue/Nuxt** — add to `nuxt.config.ts` `head.script` or `app.vue`
- **Astro** — add to `Layout.astro` `<head>`

### 4. Query Your Data

Your agent reads the data instead of you opening a dashboard:

```bash
npx agent-analytics stats my-site              # Last 7 days
npx agent-analytics stats my-site --days 30    # Last 30 days
npx agent-analytics events my-site             # Recent events
npx agent-analytics projects                   # List all projects
```

Your agent turns that into: *"4,821 pageviews from 1,203 unique visitors this week, up 23% from last week. 127 signup clicks at 2.6% conversion."*

---

## Hosting Options

| | **Hosted** | **Self-Hosted** |
|---|---|---|
| **Setup** | Sign in at [app.agentanalytics.sh](https://app.agentanalytics.sh) | Deploy this repo to Cloudflare or Node.js |
| **CLI** | `npx agent-analytics login --token aak_xxx` | `npx agent-analytics login --token your_key --url https://your-worker.dev` |
| **API URL** | `https://app.agentanalytics.sh` (default) | Your own Worker URL |
| **API key** | Generated in dashboard | You choose it at deploy time (`API_KEYS` env var) |

### Self-Hosted: Cloudflare Workers (recommended)

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

**Update `wrangler.toml`:**
- Replace `YOUR_DATABASE_ID` with your actual database ID.
- Optionally change `name` at the top for a custom Worker name (determines your deploy URL).

> ⚠️ **Important:** Keep the binding as `DB` — don't copy the binding name from the `d1 create` output (it generates `agent_analytics`, but the code expects `DB`).

```bash
# 3. Initialize the schema
npx wrangler d1 execute agent-analytics --remote --file=./schema.sql
```

> **Troubleshooting:** Authentication error? Set your account ID:
> ```bash
> export CLOUDFLARE_ACCOUNT_ID=your-account-id
> ```

```bash
# 4. Install dependencies
npm install

# 5. Deploy
npx wrangler deploy

# 6. Set secrets (after deploy — the Worker must exist first)
echo "your-secret-read-key" | npx wrangler secret put API_KEYS
echo "pt_your-project-token" | npx wrangler secret put PROJECT_TOKENS
```

Your endpoint: `https://agent-analytics.YOUR-SUBDOMAIN.workers.dev`

<details>
<summary>Optional: Enable Queue (high-traffic sites)</summary>

By default, events write directly to D1 via `ctx.waitUntil()` — already non-blocking. For very high-traffic sites, enable [Cloudflare Queues](https://developers.cloudflare.com/queues/) for batching and retries (requires Workers Paid plan, $5/month).

```bash
npx wrangler queues create agent-analytics-events
```

Uncomment `[[queues.producers]]` and `[[queues.consumers]]` in `wrangler.toml`, then `npx wrangler deploy`.

Events are batch-written (up to 100 per batch, flushed every 5s). Falls back to direct write if the queue fails.
</details>

### Self-Hosted: Node.js

```bash
git clone https://github.com/Agent-Analytics/agent-analytics.git
cd agent-analytics && npm install

API_KEYS=my-secret-key PROJECT_TOKENS=pt_my-token npm start
# Or: PORT=3000 DB_PATH=./data/analytics.db API_KEYS=key1,key2 npm start
```

---

## CLI Reference

Everything you can do with the API, you can do with `npx agent-analytics`:

```bash
# Auth
npx agent-analytics login --token YOUR_KEY           # Save credentials
npx agent-analytics whoami                            # Show current account

# Projects
npx agent-analytics init my-site --domain https://mysite.com    # Create + get snippet & token
npx agent-analytics projects                                     # List all projects
npx agent-analytics delete <project-id>                          # Delete a project

# Query (your agent runs these)
npx agent-analytics stats my-site                    # Last 7 days overview
npx agent-analytics stats my-site --days 30          # Custom period
npx agent-analytics events my-site                   # Recent raw events
npx agent-analytics events my-site --days 30 --limit 50   # With filters

# Account
npx agent-analytics revoke-key                       # Revoke + regenerate API key
```

**Environment variables:**
- `AGENT_ANALYTICS_KEY` — API key (overrides config file)
- `AGENT_ANALYTICS_URL` — Custom API URL (for self-hosted instances)

**npm:** <https://www.npmjs.com/package/agent-analytics>

---

## API Reference

Everything the CLI does is also available as HTTP endpoints. Use `X-API-Key` header or `?key=` param for auth.

### Auth & Keys

Two types of keys — same model as Mixpanel:

| Key | Purpose | Visibility | Used by |
|-----|---------|------------|---------|
| **Project Token** (`pt_...`) | Identifies which project events belong to | Public (embedded in JS snippet) | `tracker.js`, `/track` |
| **API Key** | Read access to query stats | **Private** (keep secret) | CLI, `/stats`, `/events`, `/query` |

### Tracking Events

#### `POST /track` — Single event

Called automatically by `tracker.js` on your site. You don't need to call this manually.

```bash
curl -X POST "https://app.agentanalytics.sh/track" \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-site",
    "token": "pt_your_token",
    "event": "page_view",
    "properties": { "page": "/home", "browser": "chrome" },
    "user_id": "user_123"
  }'
```

| Field | Required | Description |
|-------|----------|-------------|
| `project` | ✅ | Project identifier |
| `token` | ✅* | Project token (*optional if `PROJECT_TOKENS` not set on server) |
| `event` | ✅ | Event name |
| `properties` | | Arbitrary JSON |
| `user_id` | | User identifier |
| `timestamp` | | Unix ms (defaults to now) |

#### `POST /track/batch` — Up to 100 events at once

Each event carries its own `project` field. Auth token is at the top level.

```bash
curl -X POST "https://app.agentanalytics.sh/track/batch" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "pt_your_token",
    "events": [
      { "project": "my-site", "event": "click", "user_id": "u1" },
      { "project": "my-site", "event": "scroll", "user_id": "u2" }
    ]
  }'
```

| Field | Required | Description |
|-------|----------|-------------|
| `token` | ✅* | Project token (*optional if `PROJECT_TOKENS` not set) |
| `events` | ✅ | Array of event objects (max 100) |
| `events[].project` | ✅ | Project identifier (per event) |
| `events[].event` | ✅ | Event name |
| `events[].properties` | | Arbitrary JSON |
| `events[].user_id` | | User identifier |
| `events[].timestamp` | | Unix ms (defaults to now) |

### Querying Data

#### `GET /stats` — Aggregated overview

```bash
npx agent-analytics stats my-site --days 7
```

<details>
<summary>curl equivalent</summary>

```bash
curl "https://app.agentanalytics.sh/stats?project=my-site&days=7" \
  -H "X-API-Key: YOUR_API_KEY"
```
</details>

Returns daily breakdown (unique users + total events), top events by count, and period totals.

```json
{
  "project": "my-site",
  "period": { "from": "2026-02-01", "to": "2026-02-07", "days": 7 },
  "totals": { "unique_users": 1203, "total_events": 4821 },
  "daily": [{ "date": "2026-02-07", "unique_users": 187, "total_events": 712 }],
  "events": [
    { "event": "page_view", "count": 3920 },
    { "event": "signup_click", "count": 127 }
  ]
}
```

#### `GET /events` — Raw event log

```bash
npx agent-analytics events my-site --event page_view --days 7 --limit 100
```

<details>
<summary>curl equivalent</summary>

```bash
curl "https://app.agentanalytics.sh/events?project=my-site&event=page_view&days=7&limit=100" \
  -H "X-API-Key: YOUR_API_KEY"
```
</details>

#### `POST /query` — Flexible analytics query

The power endpoint. Supports metrics, grouping, filtering, and sorting.

```bash
curl -X POST "https://app.agentanalytics.sh/query" \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-site",
    "metrics": ["event_count", "unique_users"],
    "group_by": ["event", "date"],
    "filters": [
      { "field": "event", "op": "eq", "value": "page_view" },
      { "field": "properties.browser", "op": "eq", "value": "chrome" }
    ],
    "date_from": "2026-01-01",
    "date_to": "2026-01-31",
    "order_by": "event_count",
    "order": "desc",
    "limit": 50
  }'
```

| Parameter | Description |
|-----------|-------------|
| `metrics` | `event_count`, `unique_users` |
| `group_by` | `event`, `date`, `user_id` |
| `filters[].op` | `eq`, `neq`, `gt`, `lt`, `gte`, `lte` |
| `filters[].field` | `event`, `user_id`, `date`, or `properties.*` for JSON property filters |
| `order_by` | Any metric or group_by field |
| `limit` | Max 1000 rows (default: 100) |

#### `GET /properties` — Discover events & property keys

```bash
curl "https://app.agentanalytics.sh/properties?project=my-site&days=30" \
  -H "X-API-Key: YOUR_API_KEY"
```

Returns event names with counts, first/last seen dates, and all known property keys. Useful for building dynamic queries.

### Utility

| Endpoint | Description |
|----------|-------------|
| `GET /health` | `{ "status": "ok", "service": "agent-analytics" }` |
| `GET /tracker.js` | Client-side tracking script (see [Add Tracking](#3-add-tracking-to-your-site)) |

---

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

## License

MIT
