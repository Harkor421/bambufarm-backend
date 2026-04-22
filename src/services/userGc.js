/**
 * User garbage collection — deletes a user and all their related records.
 *
 * Called when we have definitive proof the user is gone (Expo's DeviceNotRegistered
 * or APNS 410 Unregistered means the app was uninstalled, push token is permanently
 * dead). Keeping these records around wastes:
 *   - Bambu API calls (poller and MQTT setup keep retrying their tokens)
 *   - APNS calls (every state change tries to push to a dead token)
 *   - DB rows on every user-iteration query
 *
 * Safe to call concurrently — a deduplication window prevents the same user
 * from being deleted multiple times in a burst of failures.
 */

const log = require("../utils/logger");

// printerToken/userId already deleted in last 5 min — skip
const recentlyDeleted = new Map();
const RECENTLY_DELETED_TTL_MS = 5 * 60 * 1000;

function recentlyDeletedKey(filter) {
  if (filter.expo_push_token) return `expo:${filter.expo_push_token}`;
  if (filter._id) return `id:${filter._id}`;
  return JSON.stringify(filter);
}

function pruneRecentlyDeleted() {
  const cutoff = Date.now() - RECENTLY_DELETED_TTL_MS;
  for (const [k, ts] of recentlyDeleted) {
    if (ts < cutoff) recentlyDeleted.delete(k);
  }
}

/**
 * Delete a user and all related records.
 *
 * @param {object} filter - MongoDB filter to find the user (e.g., { expo_push_token: "..." })
 * @param {string} reason - Why we're deleting (logged for audit)
 * @returns {Promise<boolean>} true if a user was deleted
 */
async function deleteUserAndRelated(filter, reason) {
  const key = recentlyDeletedKey(filter);
  if (recentlyDeleted.has(key)) return false;
  recentlyDeleted.set(key, Date.now());
  pruneRecentlyDeleted();

  try {
    const User = require("../db/models/User");
    const PrinterState = require("../db/models/PrinterState");

    const user = await User.findOne(filter).select("_id expo_push_token bambu_uid").lean();
    if (!user) return false;

    const tasks = [
      User.deleteOne({ _id: user._id }),
      PrinterState.deleteMany({ user_id: user._id }),
    ];

    // Optional collections that may not exist in every deployment
    try {
      const NotificationHistory = require("../db/models/NotificationHistory");
      tasks.push(NotificationHistory.deleteMany({ user_id: user._id }));
    } catch {}
    try {
      const MessageState = require("../db/models/MessageState");
      tasks.push(MessageState.deleteMany({ user_id: user._id }));
    } catch {}

    await Promise.all(tasks.map((p) => p.catch(() => {})));

    log.info(
      `[USER-GC] Deleted user ${user._id} (uid=${user.bambu_uid || "?"}, expo=${
        user.expo_push_token ? user.expo_push_token.slice(0, 24) + "…" : "?"
      }) — reason: ${reason}`
    );
    return true;
  } catch (err) {
    log.error(`[USER-GC] Delete failed: ${err.message}`);
    return false;
  }
}

module.exports = { deleteUserAndRelated };
