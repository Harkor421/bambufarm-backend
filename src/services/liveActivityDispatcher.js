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
 * Dispatch a Live Activity update for a state transition.
 *
 * Iterates ALL user records sharing the same Bambu account so we send the
 * update to every device that has an active LA, deduping by token. This avoids
 * the previous bug where a single bambu_uid with N user records would log N
 * "no activity token" warnings even though only one device actually had the LA.
 *
 * For starts: fires push-to-start to every unique la_push_to_start_token.
 * For updates/ends: fires update/end to every unique la_activity_token across
 * the account; if NO token exists for a still-active state (PAUSE/RUNNING),
 * falls back to push-to-start to spawn a fresh LA so the user still sees state.
 *
 * @param {object[]} users - All user records with the same bambu_uid
 * @param {string} devId - Printer device ID
 * @param {object} notification - { data: { type, ... } }
 * @param {object} state - MQTT state
 * @param {string} gcodeState - Current gcode state
 * @param {string} effectivePrev - Previous gcode state
 * @param {string} printerName - Printer display name
 * @returns {boolean} true if at least one APNs delivery succeeded
 */
async function dispatchLiveActivity(users, devId, notification, state, gcodeState, effectivePrev, printerName) {
  if (!apns.isConfigured()) return false;
  if (!Array.isArray(users) || users.length === 0) return false;

  const jobTitle = state.subtask_name || "Print Job";
  const nowSec = Math.floor(Date.now() / 1000);
  const remaining = (state.mc_remaining_time || 0) * 60;
  const progress = normalizeProgress(gcodeState, effectivePrev, state.mc_percent);
  const type = notification.data.type;

  // Collect unique tokens across all user records for this bambu_uid
  const startTokens = new Map(); // pushToStartToken → user (whose record holds it)
  const activityTokens = new Map(); // activityToken → { user, devId }
  for (const u of users) {
    if (u.la_push_to_start_token && !startTokens.has(u.la_push_to_start_token)) {
      startTokens.set(u.la_push_to_start_token, u);
    }
    const actTok = getActivityToken(u, devId);
    if (actTok && !activityTokens.has(actTok)) {
      activityTokens.set(actTok, { user: u, devId });
    }
  }

  let anySuccess = false;

  try {
    if (type === "print_started") {
      // Fire push-to-start for every unique device's push-to-start token
      const contentState = {
        jobTitle, progress,
        startTime: nowSec,
        endTime: remaining > 0 ? nowSec + remaining : nowSec,
        status: "printing",
      };
      for (const [tok] of startTokens) {
        const r = await apns.sendLiveActivityStart(tok, { printerId: devId, printerName }, contentState);
        if (r?.success) anySuccess = true;
        log.info(`[LA] print_started for ${devId}: ${r?.success ? "sent" : "failed"}`);
      }
      return anySuccess;
    }

    if (type === "print_finished" || type === "print_error") {
      const isCancelled = type === "print_error";
      if (activityTokens.size === 0) {
        // Print ended but we never had an activity token — LA either expired or
        // never existed. Nothing to end. Quietly skip; this is normal.
        log.debug(`[LA] No activity token for ${devId}, nothing to end (likely expired or never created)`);
        return false;
      }
      const finalState = {
        jobTitle: isCancelled ? "Cancelled" : jobTitle,
        progress: isCancelled ? progress : 1.0,
        startTime: nowSec, endTime: nowSec,
        status: isCancelled ? "cancelled" : "finished",
      };
      for (const [tok, { user }] of activityTokens) {
        const r = await apns.sendLiveActivityEnd(tok, finalState);
        if (r?.success) anySuccess = true;
        // Always clear after END (whether success or invalid) — the LA is over either way
        await clearActivityToken(String(user._id), devId);
        log.info(`[LA] print_${isCancelled ? "cancelled" : "finished"} for ${devId}: ${r?.success ? "sent" : "failed"}`);
      }
      return anySuccess;
    }

    // print_paused / print_resumed — UPDATE existing LA(s)
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

    if (activityTokens.size > 0) {
      for (const [tok, { user }] of activityTokens) {
        const r = await apns.sendLiveActivityUpdate(tok, contentState, 10);
        if (r?.success) anySuccess = true;
        if (isTokenInvalid(r)) await clearActivityToken(String(user._id), devId);
        log.info(`[LA] ${type} for ${devId}: ${progress * 100 | 0}% — ${r?.success ? "sent" : "failed"}`);
      }
      return anySuccess;
    }

    // FALLBACK: No activity token but the print is still active. The previous
    // LA either expired (12h limit) or was never received. Spawn a fresh LA
    // via push-to-start so the user still sees the current state. Without this
    // fallback, paused/resumed events for long prints get lost silently.
    if (startTokens.size > 0) {
      for (const [tok] of startTokens) {
        const r = await apns.sendLiveActivityStart(tok, { printerId: devId, printerName }, contentState);
        if (r?.success) anySuccess = true;
        log.info(`[LA] ${type} fallback push-to-start for ${devId}: ${r?.success ? "sent" : "failed"}`);
      }
      return anySuccess;
    }

    log.debug(`[LA] No activity or push-to-start token for ${devId} (${type}) — skipping`);
  } catch (e) {
    log.error(`[LA] Error for ${devId}: ${e.message}`);
  }

  return anySuccess;
}

module.exports = { dispatchLiveActivity };
