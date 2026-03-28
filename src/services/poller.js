const User = require("../db/models/User");
const log = require("../utils/logger");
const { ensureFreshToken } = require("./tokenRefresh");
const { fetchNormalizedPrinters } = require("./bambuClient");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lightweight poller — MQTT handles all real-time status, notifications, and Live Activities.
 * The poller only does:
 * 1. Token refresh — keeps Bambu access tokens fresh for MQTT reconnects
 * 2. Printer discovery — detects new printers added to a user's account
 */
async function pollAllUsers() {
  const users = await User.find({ fail_count: { $lt: 5 } }).lean();
  if (users.length === 0) return;

  let refreshed = 0;
  let discovered = 0;

  for (const user of users) {
    try {
      // 1. Token refresh
      await ensureFreshToken(user);
      refreshed++;

      // Reset fail_count on success (auto-recovery from temporary failures)
      if (user.fail_count > 0) {
        await User.updateOne({ _id: user._id }, { fail_count: 0 });
      }

      // 2. Printer discovery — check if user has new printers we haven't seen
      //    Only do this for users with MQTT connections so we can subscribe to new printers
      const mqttService = require("./mqttPrinterService");
      const conn = [...(mqttService.connections?.values() || [])].find(
        (c) => c.bambuUid === user.bambu_uid && c.client?.connected
      );
      if (conn) {
        const accessToken = user.bambu_access_token;
        const printers = await fetchNormalizedPrinters(accessToken);
        const knownIds = new Set(conn.printerStates?.keys() || []);
        const newPrinters = printers.filter((p) => !knownIds.has(p.id));
        if (newPrinters.length > 0) {
          log.info(`[POLL] Discovered ${newPrinters.length} new printer(s) for user ${user._id}`);
          // Subscribe to new printers via MQTT
          for (const p of newPrinters) {
            if (conn.client?.connected) {
              conn.client.subscribe(`device/${p.id}/report`);
              conn.client.publish(
                `device/${p.id}/request`,
                JSON.stringify({ pushing: { sequence_id: "0", command: "pushall", version: 1, push_target: 1 } })
              );
            }
          }
          discovered += newPrinters.length;
        }
      }
    } catch (err) {
      // Don't spam logs for expected errors (token refresh failures, etc.)
      if (err.response?.status !== 429) {
        log.error(`[POLL] User ${user._id} error: ${err.message}`);
      }
      await User.updateOne({ _id: user._id }, { $inc: { fail_count: 1 } });
    }

    if (users.length > 1) await sleep(1500);
  }

  log.info(`[POLL] Done: ${refreshed} tokens refreshed, ${discovered} new printers discovered`);
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
