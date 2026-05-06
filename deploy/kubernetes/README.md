# Run Agent Analytics on kind

This guide runs the open-source Agent Analytics server on a local `kind` cluster using the Docker image built from this repo.

Use this path when you want to test the Kubernetes deployment, generate live analytics traffic, or prepare the cluster for tools such as groundcover.

## Current assumptions

- Docker Desktop is running.
- `kind` and `kubectl` are installed.
- The cluster name is `agent-analytics`.
- The local image tag is `agent-analytics:local`.
- No official container image is published yet, so the image is built and loaded locally.
- This uses standalone `kind`, not Docker Desktop's built-in Kubernetes tab.

## 1. Create the kind cluster

```bash
kind create cluster --name agent-analytics
kubectl cluster-info --context kind-agent-analytics
kubectl get nodes --context kind-agent-analytics
```

Expected node state:

```text
agent-analytics-control-plane   Ready
```

## 2. Build and load the image

From the repo root:

```bash
cd /Users/danny/dev/agent-analytics/agent-analytics

docker build -t agent-analytics:local .
kind load docker-image agent-analytics:local --name agent-analytics
```

The Kubernetes manifest uses:

```yaml
image: agent-analytics:local
imagePullPolicy: IfNotPresent
```

That lets kind use the image loaded into its node instead of pulling from a registry.

## 3. Deploy Agent Analytics

Create the namespace and secrets:

```bash
kubectl create namespace agent-analytics --context kind-agent-analytics

kubectl -n agent-analytics create secret generic agent-analytics-secrets \
  --from-literal=API_KEYS=docker-read-key \
  --from-literal=PROJECT_TOKENS=docker-project-token \
  --context kind-agent-analytics
```

Apply the manifests:

```bash
kubectl -n agent-analytics apply -f deploy/kubernetes/service.yaml --context kind-agent-analytics
kubectl -n agent-analytics apply -f deploy/kubernetes/statefulset.yaml --context kind-agent-analytics
```

Wait for the StatefulSet:

```bash
kubectl -n agent-analytics rollout status statefulset/agent-analytics --timeout=120s --context kind-agent-analytics
kubectl -n agent-analytics get pods,pvc,svc --context kind-agent-analytics
```

Expected state:

```text
pod/agent-analytics-0                         1/1   Running
persistentvolumeclaim/data-agent-analytics-0  Bound  5Gi
service/agent-analytics                       ClusterIP  8787/TCP
```

## 4. Open local access

Port-forward the ClusterIP service:

```bash
kubectl -n agent-analytics port-forward svc/agent-analytics 18787:8787 --context kind-agent-analytics
```

Leave that process running. The server is now reachable at:

```text
http://127.0.0.1:18787
```

## 5. Create a live project

Health check:

```bash
curl http://127.0.0.1:18787/health
```

Create three events. Use a browser-like `User-Agent`; curl's default user agent can be treated as automated traffic.

```bash
curl http://127.0.0.1:18787/track \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 Kind Smoke" \
  -d '{"token":"docker-project-token","project":"kind-live-project","event":"page_view","properties":{"path":"/kind-live","source":"kind-port-forward"},"user_id":"kind-user-1"}'

curl http://127.0.0.1:18787/track \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 Kind Smoke" \
  -d '{"token":"docker-project-token","project":"kind-live-project","event":"signup_click","properties":{"path":"/pricing","plan":"pro","source":"kind-port-forward"},"user_id":"kind-user-1"}'

curl http://127.0.0.1:18787/track \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 Kind Smoke" \
  -d '{"token":"docker-project-token","project":"kind-live-project","event":"docs_viewed","properties":{"path":"/docs/install","source":"kind-port-forward"},"user_id":"kind-user-2"}'
```

Verify the project and stats:

```bash
curl "http://127.0.0.1:18787/projects" \
  -H "X-API-Key: docker-read-key"

curl "http://127.0.0.1:18787/stats?project=kind-live-project&since=7d" \
  -H "X-API-Key: docker-read-key"

curl "http://127.0.0.1:18787/events?project=kind-live-project&since=7d&limit=10" \
  -H "X-API-Key: docker-read-key"
```

Expected stats after the three events:

```text
project: kind-live-project
total_events: 3
unique_users: 2
events: page_view, signup_click, docs_viewed
```

## 6. Verify with the CLI

Point the published CLI at the kind-hosted server:

```bash
AGENT_ANALYTICS_URL=http://127.0.0.1:18787 \
AGENT_ANALYTICS_API_KEY=docker-read-key \
npx --yes @agent-analytics/cli@0.5.25 stats kind-live-project --days 7
```

Expected output:

```text
Total events: 3
Unique users: 2
```

## 7. Useful debug commands

```bash
kubectl -n agent-analytics get pods,pvc,svc --context kind-agent-analytics
kubectl -n agent-analytics logs statefulset/agent-analytics --context kind-agent-analytics
kubectl -n agent-analytics describe pod agent-analytics-0 --context kind-agent-analytics
```

## 8. Cleanup

Remove the app but keep the cluster:

```bash
kubectl delete namespace agent-analytics --context kind-agent-analytics
```

Delete the whole kind cluster:

```bash
kind delete cluster --name agent-analytics
```

## Notes for groundcover

After Agent Analytics is running in kind and the live project returns events, the cluster is ready for groundcover installation.

Install groundcover into the same `kind-agent-analytics` context, then generate `/track` and `/stats` traffic again so groundcover has workload activity to observe.
