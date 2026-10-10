/**
 * Dispatches Live Activity updates via Apple Push Notification Service.
 * Handles start, update, and end events using the correct token types.
 */

const log = require("../utils/logger");
const apns = require("./apnsSender");
const { getActivityToken, clearActivityToken, clearStartToken, isTokenInvalid, isTokenGone } = require("./apnsTokenUtils");
const ledger = require("./laStartLedger");
const laChannels = require("./laChannels");
const laFarm = require("./laFarm");
const { buildContentState, staleAfterSecFor } = require("./laContent");

// How long a finished/cancelled card stays on the lock screen.
const DISMISS_AFTER_SEC = 15 * 60;
// A second "print_started" for the same print within this window is the same
// transition seen twice (reconnect/first-connect), not a new print.
const DUPLICATE_START_WINDOW_SEC = 10 * 60;

/**
 * Send push-to-start to every unique device token, deleting tokens Apple says
 * are gone (410). Before this, dead start tokens were retried on every print
 * forever (prod: ~760 410s per 6h). 400 BadDeviceToken is NOT treated as dead
 * here — after the two-host retry it means a config problem, and deleting would
 * hide it (Alterna's rule).
 */
async function startOnAll(startTokens, attributes, contentState, label, channelId = null) {
  let anySuccess = false;
  for (const [tok, user] of startTokens) {
    const r = await apns.sendLiveActivityStart(tok, attributes, contentState, undefined, {
      staleAfterSec: staleAfterSecFor(contentState),
      channelId,
    });
    if (r?.success) anySuccess = true;
    if (isTokenGone(r)) {
      try { await clearStartToken(user._id, tok); } catch (e) { log.debug(`[LA] clearStartToken failed: ${e.message}`); }
    }
    log.info(`[LA] ${label} for ${attributes.printerId}: ${r?.success ? "sent" : isTokenGone(r) ? "token gone (cleared)" : "failed"}`);
  }
  return anySuccess;
}
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
async function dispatchLiveActivity(users, devId, notification, state, gcodeState, effectivePrev, printerName, farmCtx = null) {
  if (!apns.isConfigured()) return false;
  if (!Array.isArray(users) || users.length === 0) return false;

  const jobTitle = state.subtask_name || "Print Job";
  const bambuUid = users[0]?.bambu_uid || "none";
  const printKey = ledger.printKeyOf(state);
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
      // Busy farms get farm cards (several printers per card) instead of one
      // card per printer — see laFarm.
      if (farmCtx && (await laFarm.handleStart({ bambuUid, users, states: farmCtx.states, names: farmCtx.names }))) {
        return true;
      }
      // Fire push-to-start for every unique device's push-to-start token
      const contentState = buildContentState({ jobTitle, progress, remainingSec: remaining, status: "printing" });
      const since = ledger.secondsSinceStart(bambuUid, devId);
      if (ledger.alreadyStarted(bambuUid, devId, printKey) && since != null && since < DUPLICATE_START_WINDOW_SEC) {
        log.debug(`[LA] print_started for ${devId}: card already started ${since}s ago — skipping duplicate`);
        return false;
      }
      // iOS 18+: the card subscribes to a per-print broadcast channel so we
      // can update and end it without its (rarely delivered) update token.
      const channelId = startTokens.size > 0 ? await laChannels.openForPrint(bambuUid, devId, printKey) : null;
      anySuccess = await startOnAll(startTokens, { printerId: devId, printerName }, contentState, "print_started", channelId);
      if (anySuccess) ledger.recordStart(bambuUid, devId, printKey);
      return anySuccess;
    }

    if (type === "print_finished" || type === "print_error") {
      const isCancelled = type === "print_error";
      ledger.clear(bambuUid, devId);
      const finalState = buildContentState({
        jobTitle,
        progress: isCancelled ? progress : 1.0,
        remainingSec: 0,
        status: isCancelled ? "cancelled" : "finished",
      });
      // End through the channel first: it reaches the cards that never gave
      // us a token (the "ghost" cards).
      const br = await laChannels.broadcast(bambuUid, devId, "end", finalState, { priority: 10, dismissAfterSec: DISMISS_AFTER_SEC });
      if (br?.success) {
        anySuccess = true;
        log.info(`[LA] print_${isCancelled ? "cancelled" : "finished"} for ${devId}: ended via channel`);
      }
      if (activityTokens.size === 0) {
        if (!anySuccess) log.debug(`[LA] No activity token or channel for ${devId}, nothing to end`);
        return anySuccess;
      }
      for (const [tok, { user }] of activityTokens) {
        const r = await apns.sendLiveActivityEnd(tok, finalState, DISMISS_AFTER_SEC);
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
    const contentState = buildContentState({ jobTitle: laTitle, progress, remainingSec: remaining, status });
    const staleAfterSec = staleAfterSecFor(contentState);

    // Channel first (reaches token-less cards on iOS 18+), then tokens (iOS 17,
    // app-started cards). A device on both just sees the same state twice.
    const br = await laChannels.broadcast(bambuUid, devId, "update", contentState, { priority: 10, staleAfterSec });
    if (br?.success) anySuccess = true;

    if (activityTokens.size > 0) {
      for (const [tok, { user }] of activityTokens) {
        const r = await apns.sendLiveActivityUpdate(tok, contentState, 10, { staleAfterSec });
        if (r?.success) anySuccess = true;
        if (isTokenInvalid(r)) await clearActivityToken(String(user._id), devId);
        log.info(`[LA] ${type} for ${devId}: ${progress * 100 | 0}% — ${r?.success ? "sent" : "failed"}`);
      }
      return anySuccess;
    }
    if (anySuccess) return true; // the channel reached it — no need to start another card

    // FALLBACK: no activity token but the print is still active. Only when we
    // have NOT already started a card for this print — e.g. the print began
    // before this server process (restart) or before the user had a start
    // token. If we did start one, a second start would just stack another
    // card on the lock screen next to the frozen first one (the old behaviour:
    // ~650 stacked cards per 6h in prod). That card refreshes as soon as the
    // app runs and registers its update token.
    if (startTokens.size > 0) {
      if (farmCtx && (await laFarm.isLive(bambuUid))) return anySuccess; // the farm card covers it
      if (ledger.alreadyStarted(bambuUid, devId, printKey)) {
        log.debug(`[LA] ${type} for ${devId}: card already started for this print, no update token yet — not stacking another`);
        return false;
      }
      const channelId = await laChannels.openForPrint(bambuUid, devId, printKey);
      anySuccess = await startOnAll(startTokens, { printerId: devId, printerName }, contentState, `${type} fallback push-to-start`, channelId);
      if (anySuccess) ledger.recordStart(bambuUid, devId, printKey);
      return anySuccess;
    }

    log.debug(`[LA] No activity or push-to-start token for ${devId} (${type}) — skipping`);
  } catch (e) {
    log.error(`[LA] Error for ${devId}: ${e.message}`);
  }

  return anySuccess;
}

module.exports = { dispatchLiveActivity };
