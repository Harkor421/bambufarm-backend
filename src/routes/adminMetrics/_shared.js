/**
 * Shared state + helpers for the admin metrics route modules.
 * Lives outside the route definitions so multiple section files can use
 * scheduleEmailBackfill (called by users.js + backfill-emails endpoint)
 * and the recentActivity ring buffer (written by eventBus, read by
 * overview.js + activity.js).
 */

const User = require("../../db/models/User");
const log = require("../../utils/logger");

/* ─────────────────────────────────────────────────────────────────────────
 * Lazy email backfill
 *
 * The bambu_email field was added later, so users registered BEFORE that
 * change have null in their record. Whenever GET /admin/metrics/users
 * surfaces a user without an email, we kick off a background fetch
 * against Bambu's /v1/user-service/my/profile using the stored access
 * token. The next time the admin refetches users, the email is there.
 *
 * - Fire-and-forget: never blocks the response.
 * - Per-user dedup so a single admin reload doesn't queue duplicates.
 * - Concurrency cap (5 in-flight) so Bambu's API isn't hammered by a
 *   first-load that has hundreds of empty rows.
 * ───────────────────────────────────────────────────────────────────── */
const _emailBackfillInflight = new Set();
let _emailBackfillSlots = 5;
const _emailBackfillQueue = [];

async function _runBackfillOne(user) {
  // Dedup is handled in _emailBackfillTick (which skips already-inflight users
  // WITHOUT spending a slot). This function is only ever entered after a slot
  // has been consumed, and its try/finally below always restores that slot —
  // so there is no early return here that could leak a slot. _runBackfillOne
  // adds the id to the inflight set synchronously (before the first await), so
  // the tick loop's next iteration sees it.
  const id = String(user._id);
  _emailBackfillInflight.add(id);
  try {
    const axios = require("axios");
    const profile = await axios.get("https://api.bambulab.com/v1/user-service/my/profile", {
      headers: { Authorization: `Bearer ${user.bambu_access_token}` },
      timeout: 5000,
    });
    const update = {};
    if (profile.data?.email) update.bambu_email = profile.data.email;
    if (profile.data?.account) update.bambu_account = profile.data.account;
    const nm = profile.data?.name || profile.data?.nickName;
    if (nm) update.bambu_name = nm;
    if (Object.keys(update).length > 0) {
      await User.updateOne({ _id: user._id }, { $set: update });
      log.info(
        `[BACKFILL] user ${id} → ${update.bambu_email || update.bambu_account || nm || "(no email)"}`
      );
    }
  } catch (err) {
    // Most failures are 401 (expired token) — that user's email will be
    // filled when they next open the app and re-register.
    if (err?.response?.status !== 401) {
      log.warn(`[BACKFILL] user ${id} failed: ${err?.response?.status || err.message}`);
    }
  } finally {
    _emailBackfillInflight.delete(id);
    _emailBackfillSlots += 1;
    _emailBackfillTick();
  }
}

function _emailBackfillTick() {
  while (_emailBackfillSlots > 0 && _emailBackfillQueue.length > 0) {
    const u = _emailBackfillQueue.shift();
    // Skip a user that's already running — but DON'T spend a slot on them.
    // (Previously the slot was decremented here and the duplicate's early
    // return in _runBackfillOne never gave it back, permanently leaking slots
    // until the queue stopped draining.)
    if (_emailBackfillInflight.has(String(u._id))) continue;
    _emailBackfillSlots -= 1;
    _runBackfillOne(u);
  }
}

function scheduleEmailBackfill(user) {
  if (!user?.bambu_access_token) return;
  if (_emailBackfillInflight.has(String(user._id))) return;
  _emailBackfillQueue.push(user);
  _emailBackfillTick();
}

/**
 * Called once on server boot to enqueue every user that's missing an email.
 * Runs through the same throttled queue as the lazy + bulk paths so Bambu's
 * API stays happy. Safe to invoke multiple times — per-user dedup prevents
 * repeats.
 */
async function bootBackfillEmails() {
  try {
    const candidates = await User.find({
      bambu_email: { $in: [null, ""] },
      bambu_access_token: { $exists: true, $ne: "" },
    })
      .select("_id bambu_access_token")
      .lean();
    if (candidates.length === 0) return;
    log.info(`[BACKFILL] Boot scan: ${candidates.length} user(s) missing email — enqueueing`);
    for (const u of candidates) scheduleEmailBackfill(u);
  } catch (err) {
    log.warn(`[BACKFILL] Boot scan failed: ${err.message}`);
  }
}

/**
 * Recent state-change activity log (in-memory, last N events). Populated
 * by mqttPrinterService via eventBus. Read by overview.js + activity.js.
 */
const RECENT_ACTIVITY_MAX = 200;
const recentActivity = [];

function attachActivityLog() {
  try {
    const eventBus = require("../../services/eventBus");
    const { EVENTS } = require("../../services/eventBus");
    eventBus.on(EVENTS.PRINTER_STATE_CHANGE, ({ bambuUid, devId, state, prev }) => {
      recentActivity.unshift({
        at: new Date().toISOString(),
        bambuUid: String(bambuUid || ""),
        printerId: devId,
        from: prev || "?",
        to: state?.gcode_state || "?",
        progress: state?.mc_percent ?? null,
        jobTitle: state?.subtask_name || null,
      });
      if (recentActivity.length > RECENT_ACTIVITY_MAX) recentActivity.length = RECENT_ACTIVITY_MAX;
    });
  } catch (err) {
    log.warn(`[ADMIN] Could not attach activity log listener: ${err.message}`);
  }
}

module.exports = {
  scheduleEmailBackfill,
  bootBackfillEmails,
  attachActivityLog,
  recentActivity,
  RECENT_ACTIVITY_MAX,
};
