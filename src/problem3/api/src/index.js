const express = require("express");
const { Pool } = require("pg");
const Redis = require("ioredis");

const PORT = Number(process.env.PORT || 3000);

const app = express();

// --- Postgres -------------------------------------------------------------
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  // Fail fast instead of queueing forever when the pool/DB is saturated.
  connectionTimeoutMillis: 5_000,
  // Kill runaway queries server-side.
  statement_timeout: 5_000,
  query_timeout: 6_000,
});

// Without this listener, an idle client being dropped (DB restart, failover,
// network blip, pg_terminate_backend) emits an unhandled 'error' event and
// crashes the whole Node process.
pool.on("error", (err) => {
  console.error("[pg] idle client error (client discarded):", err.message);
});

// --- Redis (non-critical cache) -------------------------------------------
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT || 6379),
  // Don't hold requests hostage while Redis is unavailable.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 2_000,
  commandTimeout: 1_000,
  retryStrategy: (times) => Math.min(times * 200, 2_000),
});
redis.on("error", (err) => console.error("[redis]", err.message));

// --- Routes ---------------------------------------------------------------
app.get("/api/users", async (req, res) => {
  try {
    // pool.query() always returns the client to the pool, even on error
    // (the old connect()/release() pattern leaked the client on any failure).
    const result = await pool.query("SELECT NOW()");

    // Best-effort write: a Redis outage must not fail a request the DB served.
    redis.set("last_call", Date.now()).catch((err) =>
      console.warn("[redis] set last_call failed:", err.message)
    );

    res.json({ ok: true, time: result.rows[0] });
  } catch (err) {
    console.error("[api] /api/users failed:", err.message);
    res.status(503).json({ ok: false, error: "database unavailable" });
  }
});

app.get("/status", (req, res) => {
  res.json({ status: "ok" });
});

const server = app.listen(PORT, () => console.log(`API running on ${PORT}`));
// Keep upstream keep-alive longer than nginx's to avoid 502s on reused sockets.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// --- Graceful shutdown ----------------------------------------------------
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
