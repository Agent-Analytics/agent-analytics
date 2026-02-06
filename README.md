# Agent Analytics

Simple, free analytics for AI agents. Built on Cloudflare Workers + D1.

## Deploy (5 minutes)

### 1. Install Wrangler CLI
```bash
npm install -g wrangler
wrangler login
```

### 2. Create D1 Database
```bash
cd /path/to/agent-analytics
wrangler d1 create agent-analytics
```

Copy the `database_id` from output and paste into `wrangler.toml`.

### 3. Initialize Schema
```bash
wrangler d1 execute agent-analytics --file=./schema.sql
```

### 4. Deploy Worker
```bash
wrangler deploy
```

You'll get a URL like: `https://agent-analytics.<your-subdomain>.workers.dev`

---

## Usage

### Client-Side (Web)

Add to your HTML:
```html
<script src="https://agent-analytics.YOUR.workers.dev/tracker.js" 
        data-project="myproject"></script>
```

Then track events:
```javascript
// Auto page_view happens on load

// Custom events
aa.track('button_click', { button: 'signup' });
aa.track('form_submit', { form: 'contact' });

// Identify logged-in users
aa.identify('user_123');
```

### Server-Side (Agents, APIs)

```bash
# Track an event
curl -X POST https://agent-analytics.YOUR.workers.dev/track \
  -H "Content-Type: application/json" \
  -d '{
    "project": "myproject",
    "event": "task_completed",
    "properties": {"task": "email_sent", "duration_ms": 1500},
    "user_id": "agent_cluka"
  }'

# Get stats
curl "https://agent-analytics.YOUR.workers.dev/stats?project=myproject&days=7"

# Get raw events
curl "https://agent-analytics.YOUR.workers.dev/events?project=myproject&event=page_view&days=7&limit=50"
```

---

## API Reference

### POST /track
Ingest an event.

```json
{
  "project": "myproject",      // required
  "event": "page_view",        // required
  "properties": {...},         // optional
  "user_id": "user_123",       // optional
  "timestamp": 1234567890000   // optional, defaults to now
}
```

### GET /stats
Get aggregated statistics.

| Param | Required | Description |
|-------|----------|-------------|
| project | yes | Project ID |
| days | no | Days to look back (default: 7) |

Response:
```json
{
  "project": "myproject",
  "period": { "from": "2026-01-30", "to": "2026-02-06", "days": 7 },
  "totals": { "unique_users": 258, "total_events": 1420 },
  "daily": [
    { "date": "2026-02-05", "unique_users": 32, "total_events": 180 }
  ],
  "events": [
    { "event": "page_view", "count": 1200, "unique_users": 245 }
  ]
}
```

### GET /events
Get raw events (for debugging or detailed analysis).

| Param | Required | Description |
|-------|----------|-------------|
| project | yes | Project ID |
| event | no | Filter by event name |
| days | no | Days to look back (default: 7) |
| limit | no | Max events (default: 100, max: 1000) |

### GET /tracker.js
Client-side tracking script.

### GET /health
Health check endpoint.

---

## Migrate from Mixpanel

Replace:
```html
<!-- Old Mixpanel -->
<script src="https://cdn.mxpnl.com/..."></script>
<script>mixpanel.init('TOKEN');</script>
```

With:
```html
<!-- Agent Analytics -->
<script src="https://agent-analytics.YOUR.workers.dev/tracker.js" 
        data-project="clawflows"></script>
```

API mapping:
- `mixpanel.track(event, props)` → `aa.track(event, props)`
- `mixpanel.identify(id)` → `aa.identify(id)`

---

## Cost

**Free tier covers:**
- 100,000 requests/day
- 5GB D1 storage
- 5M rows read/day

For most agent projects, this is unlimited free forever.

---

## Roadmap (maybe)

- [ ] Dashboard UI
- [ ] API keys per project
- [ ] Retention/funnel queries
- [ ] Export to CSV
- [ ] Webhooks on events
