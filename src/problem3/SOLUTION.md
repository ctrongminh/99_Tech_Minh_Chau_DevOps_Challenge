# Problem 3 – Debugging an unreliable Docker Compose platform

## Summary

The API was **always** unreachable through nginx (wrong upstream port) and, once that is fixed, would still **hang or fail** on routine dependency events (a Redis blip, a database outage, the API container restarting with a new IP).

## How I diagnosed it

1. **Read the config end to end** (compose → nginx → API → DB init) and traced one request: `:8080 → nginx → api:? → postgres/redis`.
2. **Reproduced each suspected failure** against the original code with Postgres 16, Redis 7 and Node running locally:
   - `curl` to the port nginx targets (3001) → connection refused; the API listens on 3000. Through a real nginx with the original config, `/api/users` returned **502**; with `api:3000` it returned **200**.
   - Through nginx, `/status` and `/api/status` both return error pages, never the API's `{"status":"ok"}`. Directly on `api:3000/status` it returns 200.
   - `docker compose stop postgres`, then `docker compose restart api`: the API logs `API running on 3000`, but `/api/users` through nginx returns **502 Bad Gateway** and keeps doing so. The API's IP changed (reproduced: postgres `.2`, redis `.3`, api `.4`; after stopping postgres and restarting the API it came back as `.2`), while nginx was still sending to the old address. `nginx -s reload` makes it work again.
   - `docker compose stop redis`, then call `/api/users` → it **hangs ~9 s, then returns 500** `{"ok":false,"error":"Reached the max retries per request limit (which is 20)..."}`, even though Postgres answered the query fine. The API log fills with `[ioredis] Unhandled error event: Error: getaddrinfo ENOTFOUND redis`: Docker's DNS drops the `redis` name once the container stops, so every reconnect fails; with no `error` listener ioredis prints "Unhandled error event", and the queued `SET` is rejected after 20 reconnect attempts.
   - Stopping Postgres → `/api/users` returns `500 {"ok":false,"error":"getaddrinfo ENOTFOUND postgres"}` (confirmed on the real stack), exposing internal hostnames to clients, while `/status` keeps returning `{"status":"ok"}`. The health signal shows nothing about dependencies.
3. **Re-ran the same scenarios after the fixes** (results below).

## Problems found, root causes and fixes

| # | Problem | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | **Every `/api/*` request returns 502** | `nginx/conf.d/default.conf` proxies to `api:3001`; the app listens on `3000`. | `proxy_pass` → `api:3000`. |
| 2 | **502 after the API container restarts** | nginx resolves `api` once at startup and keeps that IP. Docker gives a restarted container the lowest free address, so it can come back on a different IP (e.g. stop Postgres, restart the API: the API takes Postgres's freed address). nginx keeps proxying to the old IP and returns 502 although the API is running. | `resolver 127.0.0.11 valid=10s` (Docker's DNS) and `proxy_pass` through a variable (`set $api_upstream http://api:3000;`), so nginx re-resolves `api` every 10 s. |
| 3 | **Connection leak → requests hang** | `pool.connect()` + `db.release()` outside `finally`: any query error leaks the client. After 10 leaks the pool is empty, and `connectionTimeoutMillis` defaults to **0 (wait forever)**. | Use `pool.query()` (always releases). Add `connectionTimeoutMillis: 5000`, `statement_timeout`, `query_timeout`. |
| 4 | **Redis blip fails/hangs requests the DB already served** | `await redis.set()` sits on the critical path. ioredis queues offline commands and retries 20× before it fails. There is also no `error` listener. | Redis write is best effort (not awaited, errors logged), so the response no longer depends on Redis. `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, `commandTimeout`, `redis.on('error')`. |
| 5 | **`/status` is not reachable through nginx** | nginx only defines `location = /` and `location /api/`. `GET /status` matches neither, so nginx tries to serve a static file and returns an error page instead of proxying. `GET /api/status` is proxied unchanged as `/api/status`, which Express doesn't define (404). The route only answers inside the Docker network on `api:3000`. | No change. `/status` is used internally by the container healthcheck. If external monitoring needs it, add `location = /status { proxy_pass http://api:3000; }`. |
| 6 | **Start-up race** | `depends_on` only waits for the container to *start*, not to be *ready*, and there were no healthchecks. | Healthchecks on postgres (`pg_isready`), redis (`ping`), api (`/status`) and nginx. `depends_on: condition: service_healthy`. |
| 7 | **Misleading health endpoint** | `/status` returns ok even when the DB is down. | Not changed in code (no new endpoints added). Recommendation: add a readiness check that verifies Postgres, separate from the `/status` liveness check. |
| 8 | **DB tuning file never applied, and was harmful** | `postgres/init.sql` was not mounted. If it had been, `max_connections = 20` (only after a restart) is too low: one API replica's pool alone uses 10. | Mounted to `/docker-entrypoint-initdb.d`. `max_connections=100` set explicitly via `command:`. |
| 9 | **Data loss on recreate** | No volumes for Postgres/Redis. | Named volumes `pgdata` and `redisdata`. Redis AOF plus `maxmemory` with an LRU policy. |
| 10 | **Slow/unclean shutdowns, 502s on deploy** | Node runs as PID 1 with no SIGTERM handler, so Docker waits 10 s and then SIGKILLs it. | `init: true`, plus a SIGTERM handler that drains HTTP, then closes the pool and Redis. |
| 11 | Hygiene | Hard-coded credentials, empty `.env`, obsolete `version:` key, container runs as root, prod/dev deps mixed. | Credentials come from `.env` via env vars. `version:` removed. `USER node`, `NODE_ENV=production`, `--omit=dev`. nginx forwards client info to the API (`Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`). |

Note: `nginx/nginx.conf` is an empty file. It isn't mounted, so it's harmless today. If someone mounts it over `/etc/nginx/nginx.conf`, nginx will not start, so it should be deleted.

## Verification (after fixes)

| Scenario | Before | After |
|---|---|---|
| Normal request | 502 via nginx (port 3001) | 200 |
| Postgres stopped, then API container restarted | **502 Bad Gateway** (nginx still sends to the API's old IP) | API answers through nginx (its own DB error JSON, e.g. `getaddrinfo ENOTFOUND postgres`): nginx found the API's new IP (tested on the Docker stack) |
| Redis down | 500 after ~9.5 s | 200 in ~3 ms |
| Postgres down | 500, `/status` says ok | fast 503 (no hang), recovers when Postgres returns |
| Postgres back | n/a | 200, recovers automatically |
| 200 requests, 50 concurrent | n/a | 200 × 200 |
| SIGTERM | killed after 10 s | drains and exits immediately |

`docker compose config` validates the new compose file.

## Monitoring and alerts I would add

- **Availability**: an external synthetic check on `/api/users` through nginx. Page if it fails for 2+ minutes.
- **RED metrics** (Prometheus `prom-client` in the API, nginx `stub_status` or exporter): request rate, **5xx ratio** (warn > 1 %, page > 5 % over 5 min), **p95/p99 latency**, plus nginx `502/504` counts as their own series.
- **Container health**: restart count (`increase(restarts[10m]) > 2`), unhealthy state, OOM kills, CPU and memory against limits.
- **Postgres** (`postgres_exporter`): connections used vs `max_connections` (warn at 80 %), long-running queries, replication lag, and errors.
- **API pool**: `pool.totalCount`, `idleCount` and `waitingCount`. Alert when `waitingCount > 0` is sustained.
- **Redis** (`redis_exporter`): up, memory vs `maxmemory`, evictions, rejected connections.
- **Logs**: structured JSON shipped centrally (Loki or ELK). Alert on `uncaughtException`, `[pg] idle client error` spikes and `ECONNREFUSED`.

## Preventing this in production

- **CI checks**: `docker compose config`, `nginx -t`, hadolint, ESLint (including the `no-floating-promises` style of rules), plus an **integration smoke test** that brings the stack up and curls through nginx. That alone would have caught the 3000/3001 mismatch.
- **Chaos and failure tests in CI**: restart Postgres, stop Redis and kill pooled connections, then assert the API survives and recovers. These are the scenarios reproduced above.
- **Upstream address changes**: nginx resolves `api` once at startup by default. A restarted container can get a different IP (e.g. stop Postgres, restart the API: the API takes Postgres's freed address), and nginx then returns 502 until reloaded. Fixed here with `resolver 127.0.0.11` + a variable in `proxy_pass`; in production, use the orchestrator's stable service address.
- **One source of truth for ports and config**: the port lives in a single env var used by both the app and nginx (or the orchestrator's service discovery). No hard-coded hosts or ports.
- **Orchestrator with probes** (Kubernetes or ECS): liveness on `/status`, a readiness probe that checks dependencies, ≥ 2 API replicas behind a Service, a PodDisruptionBudget, rolling deploys and resource requests/limits.
- **Managed data stores** (RDS or Cloud SQL, ElastiCache) with backups and HA. Add PgBouncer if the replica count grows.
- **Secrets** in a secret manager, not in compose or source. Images pinned by digest and scanned for vulnerabilities.
- **Code review checklist**: every client has an `error` listener, every timeout is explicit (no infinite defaults), non-critical dependencies are kept off the request's critical path, and the process shuts down gracefully.


## Suggestions for the application

**Done**

- **Node.js upgraded** from `node:20-alpine` (end of life April 2026, no more security fixes) to `node:24.22.1-alpine3.24`, which includes the [21 Oct 2026 security releases](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) (Brotli RCE, TLS hostname-check bypasses and others). Next step: pin the image by digest as well.

**Recommended**

| Area | Suggestion | Why |
|---|---|---|
| Reliability | Add a readiness check (e.g. `/ready`) that verifies Postgres, separate from `/status` | `/status` reports healthy during a DB outage, so nothing can take the API out of rotation |
| Reliability | Validate required config (`DB_HOST`, `DB_USER`, `REDIS_HOST`, …) at startup and exit with a clear message | A missing variable otherwise shows up later as confusing runtime errors |
| Reliability | Remove the `last_call` Redis write or give Redis a real purpose (e.g. caching with a TTL) | Today it is written on every request and never read: a dependency that can only cause failures |
| Observability | Structured JSON logs (`pino` / `pino-http`) with a request ID | Trace one request across nginx and the API |
| Observability | Metrics endpoint (`prom-client`): request rate, latency, errors, DB pool counts | The alerts above need these numbers |
| Build | Commit `package-lock.json` and build with `npm ci` | No lockfile + `^` ranges = every build can install different versions |
| Build | Add a `.dockerignore` (`node_modules`, `.env`, `.git`) | Keeps secrets and local artefacts out of the image if the build context grows |
| Security | `helmet`, `app.disable('x-powered-by')`, rate limiting (`limit_req` in nginx) | Basic HTTP hardening |
| Security | Docker secrets or a secret manager instead of plain env vars for DB credentials | Passwords in `.env` / environment leak via `docker inspect` and logs |
| Quality | Unit tests plus an integration test through nginx that also stops Redis and Postgres | Would have caught the 3000/3001 mismatch and the Redis hang |
| Quality | Rename `/api/users` (it returns the DB time) or make it query a users table | The name doesn't match the behaviour |
