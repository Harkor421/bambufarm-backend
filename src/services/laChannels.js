/**
 * APNs broadcast channels for Live Activities (iOS 18+).
 *
 * Why: a card created by push-to-start can only be updated/ended with its own
 * update token, and iOS hands that token to the app only when it runs —
 * measured in prod: median 2.6 h after the card appeared, ~95% of cards never
 * ended ("ghost" cards). A card started with `input-push-channel` instead
 * listens on a channel: one broadcast updates or ends it on every device of
 * the account, no token needed. Tokens remain the path for iOS 17 devices and
 * for cards the app starts itself.
 *
 * Lifecycle: one channel per (account, printer), opened on print start,
 * replaced by the next print, ended with the print and deleted at Apple ~1 h
 * later (so offline phones still get the stored "end"). A sweep also deletes
 * anything older than Apple's 12 h Live Activity lifetime.
 *
 * Degrades by itself: until the Broadcast capability is enabled on the App
 * ID, Apple answers 400 BroadcastFeatureNotEnabled → channels are skipped for
 * an hour at a time and everything works exactly as the token path did.
 * LA_CHANNELS=off disables it explicitly.
 */
const log = require("../utils/logger");
const apns = require("./apnsSender");
const LaChannel = require("../db/models/LaChannel");

const RETRY_DISABLED_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const DELETE_AFTER_END_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 13 * 60 * 60 * 1000;
const SWEEP_MS = 15 * 60 * 1000;

let disabledUntil = 0;
let warnedDisabled = false;
let sweepTimer = null;
const cache = new Map(); // `${uid}:${dev}` → { channelId|null, at }

const keyOf = (uid, dev) => `${uid}:${dev}`;

function enabled() {
  return apns.isConfigured() && process.env.LA_CHANNELS !== "off" && Date.now() >= disabledUntil;
}

/** Open a fresh channel for a print that is starting. Returns its id or null. */
async function openForPrint(bambuUid, devId, printKey) {
  if (!enabled()) return null;
  const r = await apns.createChannel();
  if (!r.success || !r.channelId) {
    if (r.reason === "BroadcastFeatureNotEnabled" || r.status === 403) {
      disabledUntil = Date.now() + RETRY_DISABLED_MS;
      if (!warnedDisabled) {
        warnedDisabled = true;
        log.warn("[LA-CHANNEL] Broadcast not enabled for the App ID — using activity tokens only (retrying hourly)");
      }
    } else {
      log.warn(`[LA-CHANNEL] create failed (${r.status}): ${r.reason}`);
    }
    return null;
  }
  try {
    const prev = await LaChannel.findOneAndUpdate(
      { bambu_uid: String(bambuUid), printer_dev_id: devId },
      { channel_id: r.channelId, print_key: printKey || null, opened_at: new Date(), ended_at: null },
      { upsert: true, new: false }
    ).lean();
    if (prev?.channel_id && prev.channel_id !== r.channelId) {
      apns.deleteChannel(prev.channel_id).catch(() => {});
    }
  } catch (e) {
    log.warn(`[LA-CHANNEL] persist failed: ${e.message}`);
  }
  cache.set(keyOf(bambuUid, devId), { channelId: r.channelId, at: Date.now() });
  log.info(`[LA-CHANNEL] opened for ${devId}`);
  return r.channelId;
}

/** The live (not ended) channel for this account+printer, or null. */
async function current(bambuUid, devId) {
  const k = keyOf(bambuUid, devId);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.channelId;
  let channelId = null;
  try {
    const doc = await LaChannel.findOne(
      { bambu_uid: String(bambuUid), printer_dev_id: devId, ended_at: null },
      { channel_id: 1 }
    ).lean();
    channelId = doc?.channel_id || null;
  } catch {
    // DB hiccup: treat as "no channel" — tokens still cover it
  }
  if (cache.size > 20000) cache.clear();
  cache.set(k, { channelId, at: Date.now() });
  return channelId;
}

/**
 * Broadcast an update/end to the print's channel (if any). On "end", the
 * channel is marked ended; it is deleted at Apple by the sweep an hour later.
 */
async function broadcast(bambuUid, devId, event, contentState, { priority = 10, staleAfterSec, dismissAfterSec } = {}) {
  if (!apns.isConfigured()) return null;
  const channelId = await current(bambuUid, devId);
  if (!channelId) return null;
  const payload = apns.liveActivityPayload(event, contentState, { staleAfterSec, dismissAfterSec });
  const r = await apns.sendBroadcast(channelId, payload, priority);
  if (!r?.success) {
    log.warn(`[LA-CHANNEL] ${event} for ${devId} failed (${r?.status}): ${r?.reason}`);
    if (r?.status === 404 || r?.status === 410) await forget(bambuUid, devId);
  }
  if (event === "end") {
    cache.set(keyOf(bambuUid, devId), { channelId: null, at: Date.now() });
    try {
      await LaChannel.updateOne({ channel_id: channelId }, { ended_at: new Date() });
    } catch {}
  }
  return r;
}

async function forget(bambuUid, devId) {
  cache.set(keyOf(bambuUid, devId), { channelId: null, at: Date.now() });
  try {
    await LaChannel.deleteOne({ bambu_uid: String(bambuUid), printer_dev_id: devId });
  } catch {}
}

/** Delete channels that ended >1h ago or outlived any Live Activity. */
async function sweep(now = Date.now()) {
  let docs = [];
  try {
    docs = await LaChannel.find({
      $or: [
        { ended_at: { $ne: null, $lte: new Date(now - DELETE_AFTER_END_MS) } },
        { opened_at: { $lte: new Date(now - MAX_AGE_MS) } },
      ],
    }).limit(500).lean();
  } catch {
    return 0;
  }
  for (const d of docs) {
    await apns.deleteChannel(d.channel_id).catch(() => {});
    await LaChannel.deleteOne({ _id: d._id }).catch(() => {});
    cache.delete(keyOf(d.bambu_uid, d.printer_dev_id));
  }
  if (docs.length) log.info(`[LA-CHANNEL] swept ${docs.length} channel(s)`);
  return docs.length;
}

function startSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweep().catch(() => {}), SWEEP_MS);
  if (sweepTimer.unref) sweepTimer.unref();
}

function _reset() {
  disabledUntil = 0;
  warnedDisabled = false;
  cache.clear();
}

module.exports = { openForPrint, current, broadcast, sweep, startSweeper, enabled, _reset };
