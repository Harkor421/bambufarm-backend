const User = require("../db/models/User");
const log = require("../utils/logger");
const { ensureFreshToken } = require("./tokenRefresh");
const { fetchNormalizedPrinters } = require("./bambuClient");

// Concurrent workers — processes users in parallel with limited parallelism.
// At 2k users, serial 1.5s sleep = 50 min per run, overflowing the 30 min interval.
// 8 workers → ~4 min per run for 2k users, still gentle on Bambu API (~130 req/min peak).
const POLL_CONCURRENCY = 8;

/**
 * Lightweight poller — MQTT handles all real-time status, notifications, and Live Activities.
 * The poller only does:
 * 1. Token refresh — keeps Bambu access tokens fresh for MQTT reconnects
 *    (ensureFreshToken skips if expires >60s away, so most users no-op)
 * 2. Printer discovery — detects new printers added to a user's account
 */
async function processUser(user) {
  const stats = { refreshed: 0, discovered: 0 };
  try {
    // 1. Token refresh (no-op if token is still valid)
    await ensureFreshToken(user);
    stats.refreshed = 1;

    if (user.fail_count > 0) {
      await User.updateOne({ _id: user._id }, { fail_count: 0 });
    }

    // 2. Printer discovery — only for users with an active MQTT connection
    const mqttService = require("./mqttPrinterService");
    const conn = [...(mqttService.connections?.values() || [])].find(
      (c) => c.bambuUid === user.bambu_uid && c.client?.connected
    );
    if (conn) {
      const printers = await fetchNormalizedPrinters(user.bambu_access_token);
      const knownIds = new Set(conn.printerStates?.keys() || []);
      const newPrinters = printers.filter((p) => !knownIds.has(p.id));
      if (newPrinters.length > 0) {
        log.info(`[POLL] Discovered ${newPrinters.length} new printer(s) for user ${user._id}`);
        for (const p of newPrinters) {
          if (conn.client?.connected) {
            conn.client.subscribe(`device/${p.id}/report`);
            conn.client.publish(
              `device/${p.id}/request`,
              JSON.stringify({ pushing: { sequence_id: "0", command: "pushall", version: 1, push_target: 1 } })
            );
          }
        }
        stats.discovered = newPrinters.length;
      }
    }
  } catch (err) {
    if (err.response?.status !== 429) {
      log.error(`[POLL] User ${user._id} error: ${err.message}`);
    }
    await User.updateOne({ _id: user._id }, { $inc: { fail_count: 1 } });
  }
  return stats;
}

async function pollAllUsers() {
  const users = await User.find({ fail_count: { $lt: 5 } }).lean();
  if (users.length === 0) return;

  let refreshed = 0;
  let discovered = 0;
  let idx = 0;

  // Parallel workers pulling from a shared queue
  async function worker() {
    while (idx < users.length) {
      const user = users[idx++];
      const stats = await processUser(user);
      refreshed += stats.refreshed;
      discovered += stats.discovered;
    }
  }

  const workers = Array.from({ length: Math.min(POLL_CONCURRENCY, users.length) }, worker);
  await Promise.all(workers);

  log.info(`[POLL] Done: ${users.length} users, ${refreshed} ok, ${discovered} new printers`);
}

let pollTimer = null;

function startPolling(intervalMs) {
  log.info(`[POLL] Starting (${intervalMs}ms interval) — token refresh + printer discovery only`);
  pollAllUsers().catch((err) => log.error(`[POLL] Initial run error: ${err.message}`));
  pollTimer = setInterval(() => {
    pollAllUsers().catch((err) => log.error(`[POLL] Error: ${err.message}`));
  }, intervalMs);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = { startPolling, stopPolling, pollAllUsers };
