const User = require("../db/models/User");
const log = require("../utils/logger");
const { ensureFreshToken } = require("./tokenRefresh");

// Concurrent workers — processes users in parallel with limited parallelism.
// At 2k users, serial 1.5s sleep = 50 min per run, overflowing the 30 min interval.
// 8 workers → ~4 min per run for 2k users, still gentle on Bambu API (~130 req/min peak).
const POLL_CONCURRENCY = 8;

/**
 * Lightweight poller — MQTT handles all real-time status, notifications, and Live
 * Activities. The poller's only job is token refresh: it keeps Bambu access
 * tokens fresh so MQTT reconnects work (ensureFreshToken skips if the token
 * expires >60s away, so most users no-op). Printer discovery is handled
 * separately by each live connection's 15-min bind-refresh, so the poller no
 * longer duplicates the /user/bind fetch (which cost one Bambu GET per user
 * every cycle for a strictly slower version of what bind-refresh already does).
 */
async function processUser(user) {
  const stats = { refreshed: 0 };
  try {
    // Token refresh (no-op if the token is still valid).
    await ensureFreshToken(user);
    stats.refreshed = 1;

    if (user.fail_count > 0) {
      await User.updateOne({ _id: user._id }, { fail_count: 0 });
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
  // Exclude the growing la_activity_tokens Map — the poller only refreshes
  // tokens; it never reads that field.
  const users = await User.find({ fail_count: { $lt: 5 } })
    .select("-la_activity_tokens")
    .lean();
  if (users.length === 0) return;

  let refreshed = 0;
  let idx = 0;

  // Parallel workers pulling from a shared queue
  async function worker() {
    while (idx < users.length) {
      const user = users[idx++];
      const stats = await processUser(user);
      refreshed += stats.refreshed;
    }
  }

  const workers = Array.from({ length: Math.min(POLL_CONCURRENCY, users.length) }, worker);
  await Promise.all(workers);

  log.info(`[POLL] Done: ${users.length} users, ${refreshed} ok`);
}

let pollTimer = null;

function startPolling(intervalMs) {
  log.info(`[POLL] Starting (${intervalMs}ms interval) — token refresh only`);
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
