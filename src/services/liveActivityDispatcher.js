/**
 * Dispatches Live Activity updates via Apple Push Notification Service.
 * Handles start, update, and end events using the correct token types.
 */

const log = require("../utils/logger");
const apns = require("./apnsSender");
const { getActivityToken, clearActivityToken, isTokenInvalid } = require("./apnsTokenUtils");
const { lookupHmsError } = require("../utils/hmsErrors");
const { normalizeProgress } = require("./notificationBuilder");

/**
 * Dispatch a Live Activity update based on the notification type.
 * @param {object} user - User record from DB
 * @param {string} devId - Device ID
 * @param {object} notification - { title, body, data: { type, ... } }
 * @param {object} state - MQTT state
 * @param {string} gcodeState - Current gcode state
 * @param {string} effectivePrev - Previous state
 * @param {string} printerName - Printer display name
 * @param {boolean} skipPushToStart - Skip LA creation
 * @returns {boolean} true if APNs delivery succeeded
 */
async function dispatchLiveActivity(user, devId, notification, state, gcodeState, effectivePrev, printerName, skipPushToStart) {
  if (!apns.isConfigured()) return false;

  const userId = String(user._id);
  const jobTitle = state.subtask_name || "Print Job";
  const nowSec = Math.floor(Date.now() / 1000);
  const remaining = (state.mc_remaining_time || 0) * 60;
  const progress = normalizeProgress(gcodeState, effectivePrev, state.mc_percent);

  try {
    if (notification.data.type === "print_started") {
      if (user.la_push_to_start_token && !skipPushToStart) {
        const contentState = {
          jobTitle, progress,
          startTime: nowSec,
          endTime: remaining > 0 ? nowSec + remaining : nowSec,
          status: "printing",
        };
        const r = await apns.sendLiveActivityStart(user.la_push_to_start_token, { printerId: devId, printerName }, contentState);
        log.info(`[LA] print_started for ${devId}: ${r?.success ? "sent" : "failed"}`);
        return !!r?.success;
      }
    } else if (notification.data.type === "print_finished" || notification.data.type === "print_error") {
      const actToken = getActivityToken(user, devId);
      if (actToken) {
        const isCancelled = notification.data.type === "print_error";
        const r = await apns.sendLiveActivityEnd(actToken, {
          jobTitle: isCancelled ? "Cancelled" : jobTitle,
          progress: isCancelled ? progress : 1.0,
          startTime: nowSec, endTime: nowSec,
          status: isCancelled ? "cancelled" : "finished",
        });
        if (r?.success) await clearActivityToken(userId, devId);
        if (isTokenInvalid(r)) await clearActivityToken(userId, devId);
        log.info(`[LA] print_${isCancelled ? "cancelled" : "finished"} for ${devId}: ${r?.success ? "sent" : "failed"}`);
        return !!r?.success;
      } else {
        log.warn(`[LA] No activity token for ${devId}, cannot end LA`);
      }
    } else {
      const actToken = getActivityToken(user, devId);
      if (actToken) {
        const status = gcodeState === "PAUSE" ? "paused" : "printing";
        let laTitle = jobTitle;
        if (gcodeState === "PAUSE") {
          const hmsAlerts = Array.isArray(state.hms) ? state.hms : [];
          if (hmsAlerts.length > 0) {
            const firstReason = lookupHmsError(hmsAlerts[0].attr, hmsAlerts[0].code);
            if (firstReason) laTitle = firstReason;
          } else {
            laTitle = "Paused by user";
          }
        }
        const contentState = {
          jobTitle: laTitle, progress,
          startTime: nowSec,
          endTime: remaining > 0 ? nowSec + remaining : nowSec,
          status,
        };
        const r = await apns.sendLiveActivityUpdate(actToken, contentState, 10);
        if (isTokenInvalid(r)) await clearActivityToken(userId, devId);
        log.info(`[LA] ${notification.data.type} for ${devId}: ${progress * 100 | 0}% — ${r?.success ? "sent" : "failed"}`);
        return !!r?.success;
      } else {
        log.warn(`[LA] No activity token for ${devId}, cannot update LA`);
      }
    }
  } catch (e) {
    log.error(`[LA] Error for ${devId}: ${e.message}`);
  }

  return false;
}

module.exports = { dispatchLiveActivity };
