<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/agent-analytics-logo-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/agent-analytics-logo-light.png" />
    <img src=".github/assets/agent-analytics-logo-light.png" alt="Agent Analytics" width="420" />
  </picture>
</p>

# Agent Analytics

Web analytics your AI agent can read. Add one script tag, store events in your own Cloudflare D1 database or SQLite file, and query the results from CLI or HTTP instead of living in a dashboard.

Works with Claude Code, Codex, Cursor, OpenClaw, or any agent that can run commands and reason over structured output.

Self-host this repo on Cloudflare Workers or Node.js. If you do not want to run infrastructure, use [Agent Analytics Cloud](https://app.agentanalytics.sh).

<p>
  <a href="https://docs.agentanalytics.sh/openapi.yaml"><img src="https://img.shields.io/badge/OpenAPI-3.1-6BA539?style=flat-square" alt="OpenAPI 3.1" /></a>
  <a href="https://github.com/Agent-Analytics/agent-analytics/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-4A4A4A?style=flat-square" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Deployment-Self--hosted-E49C48?style=flat-square" alt="Self-hosted" />
</p>

[Docs](https://docs.agentanalytics.sh) - [API](https://docs.agentanalytics.sh/api/)

## Why Agent Analytics

- Agent-readable by design. Your agent can call CLI commands or HTTP endpoints directly and reason over structured analytics data.
- Self-hostable. Run the same OSS server on Cloudflare Workers + D1 or a single Node.js process backed by SQLite.
- Lightweight. Start with one script tag, then add custom events, consent mode, click tracking, errors, performance, and vitals only when you need them.

## Choose Your Path

| Path | Best for | Tradeoff |
| --- | --- | --- |
| Cloudflare Workers | Recommended self-hosted path with low ops and a generous free tier | Requires a Cloudflare account and Wrangler deploy flow |
| Node.js | Existing VPS, container, or local infrastructure | You manage process uptime, storage, backups, and TLS |
| Managed Cloud | Fastest onboarding with no infrastructure | Hosted product, not this OSS repo |

## What It Looks Like

```bash
curl "https://your-server.com/stats?project=marketing-site&since=7d" \
  -H "X-API-Key: YOUR_API_KEY"
```

```json
{
  "project": "marketing-site",
  "period": {
    "from": "2026-03-08",
    "to": "2026-03-14",
    "groupBy": "day"
  },
  "totals": {
    "unique_users": 1203,
    "total_events": 4821
  },
  "timeSeries": [
    {
      "bucket": "2026-03-14",
      "unique_users": 187,
      "total_events": 712
    }
  ],
  "events": [
    {
      "event": "page_view",
      "count": 3920,
      "unique_users": 1203
    },
    {
      "event": "signup_click",
      "count": 127,
      "unique_users": 118
    }
  ],
  "sessions": {
    "total_sessions": 1368,
    "bounce_rate": 0.41,
    "avg_duration": 73215,
    "pages_per_session": 3.5,
    "sessions_per_user": 1.1
  }
}
```

Your agent can turn that into: "Traffic is up this week, most volume still comes from page views, and signup clicks are converting at a lower rate than the homepage traffic increase suggests."

## Quick Start: Deploy

### Cloudflare Workers (recommended)

Runs on the free tier with Cloudflare D1.

```bash
git clone https://github.com/Agent-Analytics/agent-analytics.git
cd agent-analytics
npm install

# Create a D1 database
npx wrangler d1 create agent-analytics
```

Update `wrangler.toml` with the database ID Wrangler returns.

- Replace `YOUR_DATABASE_ID` with the value from `wrangler d1 create`
- Keep the D1 binding name as `DB`
- Optionally change the Worker `name` at the top of the file

```bash
# Initialize the schema
npx wrangler d1 execute agent-analytics --remote --file=./schema.sql

# Deploy the Worker
npx wrangler deploy

# Set your read API key and public project token
echo "YOUR_API_KEY" | npx wrangler secret put API_KEYS
echo "YOUR_PROJECT_TOKEN" | npx wrangler secret put PROJECT_TOKENS
```

Your endpoint will look like `https://agent-analytics.YOUR-SUBDOMAIN.workers.dev`.

If Wrangler cannot find your account, set `CLOUDFLARE_ACCOUNT_ID` first:

```bash
export CLOUDFLARE_ACCOUNT_ID=your-account-id
```

### Node.js

```bash
git clone https://github.com/Agent-Analytics/agent-analytics.git
cd agent-analytics
npm install

API_KEYS=YOUR_API_KEY PROJECT_TOKENS=YOUR_PROJECT_TOKEN npm start
```

Optional environment variables:

- `PORT=3000` to change the server port
- `DB_PATH=./data/analytics.db` to choose the SQLite file location
- `ALLOWED_ORIGINS=https://app.example.com,https://www.example.com` to restrict browser reads

The SQLite database is created automatically if it does not exist.

### Docker

Build and run the self-hosted Node.js server with SQLite persisted in a Docker volume:

```bash
docker build -t agent-analytics:local .

docker run --rm \
  -p 8787:8787 \
  -e API_KEYS=YOUR_API_KEY \
  -e PROJECT_TOKENS=YOUR_PROJECT_TOKEN \
  -e DB_PATH=/data/analytics.db \
  -v agent_analytics_data:/data \
  agent-analytics:local
```

Then verify the server:

```bash
curl http://localhost:8787/health

curl http://localhost:8787/track \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 Smoke Test" \
  -d '{"token":"YOUR_PROJECT_TOKEN","project":"marketing-site","event":"page_view","properties":{"path":"/"}}'

curl "http://localhost:8787/stats?project=marketing-site&since=7d" \
  -H "X-API-Key: YOUR_API_KEY"
```

Or point the CLI at the Docker server:

```bash
AGENT_ANALYTICS_URL=http://localhost:8787 \
AGENT_ANALYTICS_API_KEY=YOUR_API_KEY \
npx --yes @agent-analytics/cli@0.5.25 stats marketing-site --days 7
```

For local Compose:

```bash
API_KEYS=YOUR_API_KEY PROJECT_TOKENS=YOUR_PROJECT_TOKEN docker compose up --build
```

`compose.yaml` mounts a named volume at `/data`, so the SQLite file survives container restarts.

### Kubernetes

The included Kubernetes manifests run the OSS server as a single-replica `StatefulSet` with a persistent volume mounted at `/data`.

No official container image is published yet. Build the image yourself and use that image in your cluster.

For local clusters, build and load `agent-analytics:local` into the cluster runtime:

```bash
docker build -t agent-analytics:local .

# kind
kind load docker-image agent-analytics:local

# minikube
minikube image load agent-analytics:local
```

For remote clusters, push the image to your own registry and replace `agent-analytics:local` in `deploy/kubernetes/statefulset.yaml` with your registry image.

Create secrets and apply the workload:

```bash
kubectl create secret generic agent-analytics-secrets \
  --from-literal=API_KEYS=YOUR_API_KEY \
  --from-literal=PROJECT_TOKENS=YOUR_PROJECT_TOKEN

kubectl apply -f deploy/kubernetes/service.yaml
kubectl apply -f deploy/kubernetes/statefulset.yaml
```

Optional ingress example:

```bash
kubectl apply -f deploy/kubernetes/ingress.example.yaml
```

Treat `ingress.example.yaml` as a template. Update the host, TLS secret, ingress class, and any provider-specific annotations for your cluster.

### SQLite Operational Limits

Docker is supported for one Node process serving many users calling `/track`; Docker is not the bottleneck. The practical limits are SQLite write serialization, disk speed, and long analytical reads competing with ingestion inside the Node process.

For SQLite deployments:

- run exactly one server process or Kubernetes pod against a given SQLite file
- mount a persistent volume at `/data`
- keep `DB_PATH=/data/analytics.db` or another path on that persistent volume
- do not mount the same SQLite file into multiple pods or replicas
- avoid network filesystems unless you have verified SQLite WAL locking behavior on that storage class

Move beyond SQLite when you need sustained high write volume, frequent long-window analytical queries during ingestion, or horizontally scaled API replicas. That next step should be a database adapter backed by Postgres or another client/server database, then a Kubernetes `Deployment` can scale the API separately from storage.

## Add Tracking to Your Site

```html
<script defer src="https://your-server.com/tracker.js"
        data-project="marketing-site"
        data-token="YOUR_PROJECT_TOKEN"></script>
```

In the OSS server, a project is just the string you send with each event. It shows up in `GET /projects` after the first event lands.

Use declarative HTML events when possible:

```html
<button data-aa-event="signup_click" data-aa-event-plan="pro">
  Start free trial
</button>
```

Use the JS API when event properties depend on runtime state:

```javascript
window.aa?.track('checkout_started', { plan: 'pro' });
window.aa?.identify('user_123');
window.aa?.page('Pricing');
```

For browser-side options like consent mode, click tracking, downloads, errors, performance, vitals, and cross-domain identity, see the [Tracker.js guide](https://docs.agentanalytics.sh/reference/tracker-js/).

## What Your Agent Can Do

For self-hosted OSS, point the CLI at your server with environment variables:

```bash
export AGENT_ANALYTICS_URL=https://your-server.com
export AGENT_ANALYTICS_API_KEY=YOUR_API_KEY
```

```bash
npx --yes @agent-analytics/cli@0.5.21 projects
npx --yes @agent-analytics/cli@0.5.21 stats marketing-site --days 7
npx --yes @agent-analytics/cli@0.5.21 events marketing-site --event signup_click --days 7 --limit 20
```

If your agent prefers raw JSON, use the HTTP API directly:

```bash
curl "$AGENT_ANALYTICS_URL/events?project=marketing-site&event=signup_click&since=7d&limit=20" \
  -H "X-API-Key: $AGENT_ANALYTICS_API_KEY"
```

The hosted `login` flow in the CLI is for Agent Analytics Cloud. For this self-hosted OSS server, the simplest path is `AGENT_ANALYTICS_URL` plus `AGENT_ANALYTICS_API_KEY`.

## What Gets Tracked and Stored

- Default `page_view` events include full URL, pathname, hostname, referrer, title, screen resolution, language, browser, browser version, OS, device type, timezone, UTM parameters, session count, and first-touch attribution.
- `tracker.js` uses `localStorage` for anonymous visitor ID, first-touch attribution, visit counters, consent state, and the optional local opt-out flag. It uses `sessionStorage` for session ID, last activity, and current-session UTM context.
- No cookies are required by `tracker.js`.
- Custom events, known user IDs, click/download/form/error/performance/vitals tracking, and consent gating only happen if you call the JS API or enable the related tracker attributes.
- Automated traffic that hits the tracker is filtered out of normal analytics.
- In OSS mode, raw event data stays in your Cloudflare D1 database or SQLite file. You control retention, backups, allowed origins, and API key distribution.
- Want stricter browser behavior? Enable `data-do-not-track="true"` to honor Do Not Track and `data-require-consent="true"` to buffer events until consent is granted.

## Use OSS If / Use Cloud If

| Use OSS if... | Use Cloud if... |
| --- | --- |
| You want to own storage, deployment, retention, and API keys | You want zero-ops onboarding and managed infrastructure |
| You already run Cloudflare Workers or Node.js services | You want account and project management built in |
| You want the minimal self-hosted surface in this repo | You want the broader hosted product surface without wiring it yourself |

## How the Pieces Fit

| Piece | Role |
| --- | --- |
| This repo (`agent-analytics`) | Self-hosted server, auth glue, and `tracker.js` delivery for Workers or Node.js |
| [`@agent-analytics/core`](https://github.com/Agent-Analytics/agent-analytics-core) | Platform-agnostic analytics handler, tracker, and database adapter contracts |
| [`@agent-analytics/cli`](https://www.npmjs.com/package/@agent-analytics/cli) | Agent-friendly CLI that can target your own server via `AGENT_ANALYTICS_URL` |
| [Docs](https://docs.agentanalytics.sh) | Setup guides, tracker guide, API reference, and OpenAPI spec |
| [Agent Analytics Cloud](https://app.agentanalytics.sh) | Hosted product with managed onboarding and no infrastructure |

## OSS API Surface

The self-hosted server in this repo exposes these routes:

- `GET /health`
- `GET /tracker.js`
- `POST /track`
- `POST /track/batch`
- `POST /identify`
- `GET /projects`
- `GET /stats?project=...`
- `GET /events?project=...`

Read endpoints require `X-API-Key`. Write endpoints use the public project token in the JSON body. The public docs and OpenAPI spec cover the broader Agent Analytics platform too, so treat the list above as the source of truth for the OSS server in this repo.

## Contributing

```bash
npm install
npm run dev
npm start
npm test
```

- `npm run dev` starts the Cloudflare Worker locally
- `npm start` runs the Node.js self-hosted server
- Open issues or PRs at https://github.com/Agent-Analytics/agent-analytics/issues

## License

MIT
