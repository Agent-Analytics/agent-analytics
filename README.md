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

Self-host this repo on Cloudflare Workers + D1 or Docker/Kubernetes + SQLite. If you do not want to run infrastructure, use [Agent Analytics Cloud](https://app.agentanalytics.sh).

<p>
  <a href="https://docs.agentanalytics.sh/openapi.yaml"><img src="https://img.shields.io/badge/OpenAPI-3.1-6BA539?style=flat-square" alt="OpenAPI 3.1" /></a>
  <a href="https://github.com/Agent-Analytics/agent-analytics/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-4A4A4A?style=flat-square" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Deployment-Self--hosted-E49C48?style=flat-square" alt="Self-hosted" />
</p>

[Docs](https://docs.agentanalytics.sh) - [API](https://docs.agentanalytics.sh/api/)

## Why Agent Analytics

- Agent-readable by design. Your agent can call CLI commands or HTTP endpoints directly and reason over structured analytics data.
- Self-hostable. Run the same OSS server on Cloudflare Workers + D1, Docker, Kubernetes, or a single Node.js process backed by SQLite.
- Lightweight. Start with one script tag, then add custom events, consent mode, click tracking, errors, performance, and vitals only when you need them.

## Choose Your Self-Hosted Route

<table>
  <tr>
    <td width="50%" valign="top">
      <p>
        <img src="https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers + D1" />
      </p>
      <h3>Cloudflare Workers + D1</h3>
      <p>The lowest-ops self-hosted route. Deploy the server as a Worker, store analytics in Cloudflare D1, and let Cloudflare handle edge runtime, TLS, and uptime.</p>
      <p><strong>Best for:</strong> people who already use Cloudflare or want the smallest server-management surface.</p>
      <p><strong>You manage:</strong> Wrangler deploys, D1 database setup, Worker secrets, and allowed origins.</p>
    </td>
    <td width="50%" valign="top">
      <p>
        <img src="https://img.shields.io/badge/Docker-Container-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" />
        <img src="https://img.shields.io/badge/Kubernetes-StatefulSet-326CE5?style=for-the-badge&logo=kubernetes&logoColor=white" alt="Kubernetes" />
      </p>
      <h3>Docker / Kubernetes + SQLite</h3>
      <p>The portable infrastructure route. Run the Node.js server in a container, persist SQLite on a volume, and optionally deploy it as a single-replica Kubernetes StatefulSet.</p>
      <p><strong>Best for:</strong> local infrastructure, VPS/container hosts, kind/minikube tests, or teams that want to own the runtime.</p>
      <p><strong>You manage:</strong> container uptime, SQLite persistence, backups, TLS/ingress, and the single-writer SQLite rule.</p>
    </td>
  </tr>
</table>

If you do not want to run infrastructure, use [Agent Analytics Cloud](https://app.agentanalytics.sh). That is the managed product, not this OSS server.

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

### Route 1: Cloudflare Workers + D1

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

### Route 2: Docker / Kubernetes + SQLite

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
npx --yes @agent-analytics/cli@0.5.35 stats marketing-site --days 7
```

For local Compose:

```bash
API_KEYS=YOUR_API_KEY PROJECT_TOKENS=YOUR_PROJECT_TOKEN docker compose up --build
```

`compose.yaml` mounts a named volume at `/data`, so the SQLite file survives container restarts.

#### Kubernetes

The included Kubernetes manifests run the same Docker image as a single-replica `StatefulSet` with a persistent volume mounted at `/data`.

For a full local `kind` walkthrough, including creating a live project and verifying it with the CLI, see [`deploy/kubernetes/README.md`](deploy/kubernetes/README.md).

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

#### Plain Node.js

If you do not want Docker, run the same server directly with Node.js:

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
npx --yes @agent-analytics/cli@0.5.35 projects
npx --yes @agent-analytics/cli@0.5.35 stats marketing-site --days 7
npx --yes @agent-analytics/cli@0.5.35 events marketing-site --event signup_click --days 7 --limit 20
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
- `POST /query`
- `POST /paths`
- `GET /properties?project=...`
- `GET /properties/received?project=...`
- `POST /sql`
- `POST /erasures`
- `GET /erasures?project=...`
- `GET /erasures/:id`

Read endpoints require `X-API-Key`. Write endpoints use the public project token in the JSON body. `POST /erasures` uses `X-API-Key` as well. The public docs and OpenAPI spec cover the broader Agent Analytics platform too, so treat the list above as the source of truth for the OSS server in this repo.

## Subject erasure

`POST /erasures` deletes one person from this server's database. The JSON body matches Agent Analytics Cloud: `project`, `idempotency_key`, `confirm` set to the string `erase`, and exactly one of `user_id`, `session_id`, or `email`. `include_replays` defaults to true. The delete runs to completion inside the request, so a successful call returns `200` with `status` `completed`. This server has no erasure queue and no replay storage. `replay_sessions` and `replay_objects` in the receipt are 0. Email erasure is not supported here: `email` returns `400` and `INVALID_ERASURE` because there is no email lookup index, and no rows are deleted.

Whoever holds `API_KEYS` can erase. That read key can erase every project stored in the database. The `project` string selects which rows are deleted. A project string is not an authorization boundary.

```bash
curl -s -X POST "$AGENT_ANALYTICS_URL/erasures" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_ANALYTICS_API_KEY" \
  -d '{"project":"marketing-site","idempotency_key":"erase-user-123","confirm":"erase","user_id":"user_123"}'
```

The same `idempotency_key` and body returns the original receipt. The same key with a different body returns `409` and `IDEMPOTENCY_CONFLICT`. Sending that same body again after a `failed` receipt continues the delete. The audit row stores a SHA-256 hash of the idempotency key, not the key itself. `confirm_large` must be true when the id itself matches more than 100,000 events.

`user_id` deletes that id and the ids found by walking `identity_map` for the named project. A session row is deleted only when every event in that session belongs to those ids. A session shared with someone else stays, including its events for the other person. The kept row's event count, times, and user id are recomputed from the events that remain. `session_id` deletes that session's events and session row only, with no identity walk. Rows in another project stay, even when they store the same user ids. Event properties that merely contain an id are left in place.

This server stores identity links in `identity_map` only. It does not store `identity_aliases`, `user_profiles`, or `email_lookup_index`. That is why an email subject cannot be resolved, and why `portfolio: true` is rejected. There is no portfolio scope on this server.

`GET /erasures/:id` and `GET /erasures?project=` return the receipt. The list is the 100 newest receipts for that project. A receipt includes counts and the subject type. It does not include the user id, session id, email, or idempotency key. The audit row stores a SHA-256 hash of the subject instead. That hash is still an identifier. Audit rows are deleted after 24 months.

The operator re-applies erasures after restoring a backup. Restoring a SQLite snapshot or a D1 Time Travel bookmark can put deleted rows back. This server does not keep a second copy of the receipt outside the database. After a restore, send the erasure requests again.

`POST /query` is the supported way to aggregate. `group_by` accepts the fields `event`, `date`, `user_id`, `session_id`, and `country`, plus at most one `properties.<key>`. The property value comes back on the row under that same `properties.<key>` name. Two `properties.*` entries return `400` with `INVALID_GROUP_BY`.

## Read-only SQL

`POST /sql` is the escape hatch when `/query` cannot say it. Prefer `/query`. The body is `{ "project", "sql" }` plus an optional time window: `days` (default 7, maximum 90) or both `date_from` and `date_to` (`YYYY-MM-DD`, span at most 90 days). Sending `days` together with a date bound is `400` and `INVALID_WINDOW`. The response is `{ "columns", "rows", "count", "truncated", "window", "statistics" }`. `columns` is the ordered list of names. `rows` is an array of objects keyed by those names. `window` is `{ "date_from", "date_to" }`. `statistics` is `{ "elapsed_ms", "rows_read", "expensive" }`. A statement SQLite or D1 rejects is `400` and `INVALID_SQL`.

```bash
curl -s -X POST "http://localhost:8787/sql" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"project":"marketing-site","sql":"SELECT event, count(*) AS event_count FROM events GROUP BY event"}'
```

The read API key is required. That key can query every project stored in the database. `project` chooses which rows the statement can see. It is not a separate authorization boundary.

The wrapper always limits `events` and `sessions` to that window on the indexed `date` column. A row whose `date` falls outside the window is left out of the result.

One `SELECT` is accepted, up to 20 KB. Leading `WITH` is rejected. The statement may name `events` and `sessions` at most twice in total. A third reference is `400` and `INVALID_SQL`. A recursive CTE is rejected. Parsing and the project wrapper come from `@agent-analytics/core`. The server exposes only these columns:

- `events`: `id`, `event`, `properties`, `user_id`, `session_id`, `timestamp`, `date`, `country`
- `sessions`: `session_id`, `user_id`, `project_id`, `start_time`, `end_time`, `duration`, `entry_page`, `exit_page`, `event_count`, `is_bounce`, `date`

`properties` is a JSON string. Use `json_extract` in the statement. Writes, extra statements, schema-qualified names (`main.events`, `temp.events`), catalog tables (`sqlite_master`, `sqlite_schema`, `sqlite_temp_master`), and any other table are rejected with `400` and `INVALID_SQL`. The project name is a bound parameter.

Results are capped at 1,000 rows. `truncated` is true when another row existed past that cap. A missing `LIMIT` is filled in by the server. A caller `LIMIT` above 1,000 is reduced to the cap.

Node, Docker, and Kubernetes run the statement on a second SQLite connection opened read-only (`query_only` as well). A parser miss cannot write the database file. `DB_PATH=:memory:` cannot be opened twice by the driver, so each statement there runs on a read-only snapshot of that database. `rows_read` is null on the Node path because SQLite does not report it, and `expensive` stays false.

The handler waits at most 10 seconds, then returns `504` and `SQL_TIMEOUT`. On Cloudflare Workers that ends the HTTP call only. The statement can still finish inside D1 after the response, because this binding has no way to cancel a running query.

Cloudflare Workers runs the same parser, then executes on the D1 binding named `DB`. That binding can write. Workers has no read-only D1 connection, so the parser is the only write barrier. Treat the Workers deployment as the weaker of the two. When D1 returns `meta.rows_read`, it is copied to `statistics.rows_read`, and `expensive` is true above 1,000,000 rows read.

This OSS server has no account plan, no request rate limit, and no hosted rows-read budget. It does not return `PRO_REQUIRED`, `SQL_BUDGET`, `SQL_UNAVAILABLE`, `SQL_BUSY`, or `SQL_COOLDOWN`. The hosted 10-calls-per-minute limit, the single-query lease, and the rows-read cooldown belong to Agent Analytics Cloud. A long scan on Node blocks the process until SQLite finishes, because the driver call is synchronous. The 10 second wait applies when SQL execution returns a promise, which is the Workers path.

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
