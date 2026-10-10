/**
 * The farm Live Activity: ONE card listing several printers, for accounts
 * printing on many machines at once.
 *
 * Why: iOS caps how many Live Activities an app can show (~5), and a lock
 * screen with six printer cards is unreadable anyway. From LA_FARM_THRESHOLD
 * printers in progress (default 4) the account gets farm cards instead —
 * each lists up to 4 printers in full (no "+N more"); bigger farms get more
 * cards ("__farm__", "__farm__2"…, at most 5) — and the per-printer cards are
 * closed. It updates on every state change of any
 * printer and at most every few minutes on progress, and ends when nothing is
 * printing anymore.
 *
 * Delivery is the same as for printer cards: the broadcast channel when
 * available (iOS 18+), plus the farm card's own update token when the app
 * registered it (printerId "__farm__" in /api/activity-token).
 *
 * Old app builds render the farm card as a single printer card: jobTitle says
 * "N printing" and progress/ETA are the soonest-finishing printer's.
 */
const log = require("../utils/logger");
const apns = require("./apnsSender");
const laChannels = require("./laChannels");
const LaFarmState = require("../db/models/LaFarmState");
const { timelineStart } = require("./laContent");
const { getActivityToken, clearActivityToken, clearStartToken, isTokenInvalid, isTokenGone } = require("./apnsTokenUtils");

const FARM_ID = "__farm__";
const PER_CARD = 4;
/** iOS shows only a handful of Live Activities per app; never open more than this. */
const MAX_CARDS = 5;
const TICK_MIN_MS = 3 * 60 * 1000;
const threshold = () => Math.max(2, Number(process.env.LA_FARM_THRESHOLD) || 4);

/** uid → Map(groupId → { lastPushAt, lastSig }) for this process. */
const live = new Map();

const ACTIVE = { RUNNING: "printing", PREPARE: "printing", PAUSE: "paused" };

const groupId = (i) => (i === 0 ? FARM_ID : `${FARM_ID}${i + 1}`);
const groupTitle = (i) => (i === 0 ? "Print farm" : `Print farm · ${i + 1}`);

/** Printers in progress for an account (unsorted). */
function farmRows(states, names, nowSec = Math.floor(Date.now() / 1000)) {
  const rows = [];
  for (const [devId, st] of Object.entries(states || {})) {
    const status = ACTIVE[st?.gcode_state];
    if (!status) continue;
    const progress = Math.min(1, Math.max(0, (Number(st.mc_percent) || 0) / 100));
    const remaining = (Number(st.mc_remaining_time) || 0) * 60;
    const endTime = remaining > 0 ? nowSec + remaining : nowSec;
    rows.push({
      devId,
      name: names?.[devId] || devId,
      progress,
      startTime: status === "printing" ? timelineStart(progress, endTime, nowSec) : nowSec,
      endTime,
      status,
      job: st.subtask_name || null,
    });
  }
  return rows;
}

/**
 * Split into cards of 4. Membership is STABLE (by name), so a printer doesn't
 * hop between cards when ETAs change; inside a card rows are soonest-first.
 * Only past MAX_CARDS × 4 printers does the last card carry a "+N".
 */
function farmGroups(rows) {
  const stable = [...rows].sort((a, b) => a.name.localeCompare(b.name) || a.devId.localeCompare(b.devId));
  const groups = [];
  for (let i = 0; i < stable.length && groups.length < MAX_CARDS; i += PER_CARD) {
    groups.push(stable.slice(i, i + PER_CARD));
  }
  const overflow = Math.max(0, stable.length - MAX_CARDS * PER_CARD);
  for (const g of groups) {
    g.sort((a, b) => {
      if ((a.status === "paused") !== (b.status === "paused")) return a.status === "paused" ? 1 : -1;
      return a.endTime - b.endTime;
    });
  }
  return { groups, overflow };
}

function farmContentState(rows, more = 0, nowSec = Math.floor(Date.now() / 1000)) {
  const printing = rows.filter((r) => r.status === "printing");
  const lead = printing[0] || rows[0];
  return {
    // Fallback fields: what an older single-printer widget shows.
    jobTitle: `${printing.length} printing`,
    progress: lead ? lead.progress : 1,
    startTime: lead ? lead.startTime : nowSec,
    endTime: lead ? lead.endTime : nowSec,
    status: printing.length ? "printing" : rows.length ? "paused" : "finished",
    updatedAt: nowSec,
    printers: rows.map(({ devId, ...r }) => r),
    more,
  };
}

/** Membership + statuses: a change here is pushed at priority 10. */
const signature = (rows) => rows.map((r) => `${r.devId}:${r.status}`).join(",");

/** uid → time until which "no farm" is trusted without asking the DB. */
const notLiveUntil = new Map();
const NEG_CACHE_MS = 5 * 60 * 1000;

/** Live farm cards of an account: memory first, then the DB (after a restart). */
async function loadKnown(uid) {
  const mem = live.get(uid);
  if (mem) return mem;
  const known = new Map();
  if ((notLiveUntil.get(uid) || 0) > Date.now()) return known;
  try {
    const doc = await LaFarmState.findOne({ bambu_uid: uid }, { groups: 1 }).lean();
    for (const gid of doc?.groups || []) known.set(gid, { lastPushAt: 0, lastSig: "" });
  } catch {
    // DB hiccup: treat as no farm (worst case one duplicate card)
  }
  if (known.size) live.set(uid, known);
  else {
    if (notLiveUntil.size > 50000) notLiveUntil.clear();
    notLiveUntil.set(uid, Date.now() + NEG_CACHE_MS);
  }
  return known;
}

async function saveKnown(uid, known) {
  try {
    if (known.size) {
      notLiveUntil.delete(uid);
      await LaFarmState.updateOne({ bambu_uid: uid }, { groups: [...known.keys()], updated_at: new Date() }, { upsert: true });
    } else {
      await LaFarmState.deleteOne({ bambu_uid: uid });
    }
  } catch (e) {
    log.debug(`[LA-FARM] persist failed: ${e.message}`);
  }
}

async function isLive(bambuUid) {
  return (await loadKnown(String(bambuUid))).size > 0;
}

/** Farm cards only for accounts whose installed app can render them (laVersion ≥ 2). */
const farmCapable = (users) => (users || []).some((u) => Number(u.la_version) >= 2);

/** Stale 15 min after the LAST printing row's ETA; paused-only cards never go stale. */
function farmStaleAfterSec(contentState, nowSec = Math.floor(Date.now() / 1000)) {
  const ends = (contentState.printers || []).filter((r) => r.status === "printing").map((r) => r.endTime);
  if (!ends.length) return 0;
  return Math.max(600, Math.max(...ends) - nowSec + 900);
}

async function pushGroup(bambuUid, users, gid, event, contentState, { priority = 10, dismissAfterSec } = {}) {
  const staleAfterSec = event === "update" ? farmStaleAfterSec(contentState) : 0;
  let ok = false;
  const br = await laChannels.broadcast(bambuUid, gid, event, contentState, { priority, staleAfterSec, dismissAfterSec });
  if (br?.success) ok = true;
  const seen = new Set();
  for (const u of users || []) {
    const tok = getActivityToken(u, gid);
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    const r = event === "end"
      ? await apns.sendLiveActivityEnd(tok, contentState, dismissAfterSec || 300)
      : await apns.sendLiveActivityUpdate(tok, contentState, priority, { staleAfterSec });
    if (r?.success) ok = true;
    if (event === "end" || isTokenInvalid(r)) await clearActivityToken(String(u._id), gid);
  }
  return ok;
}

async function startGroup(bambuUid, users, i, contentState, count) {
  const startTokens = new Map();
  for (const u of users || []) {
    if (u.la_push_to_start_token && !startTokens.has(u.la_push_to_start_token)) startTokens.set(u.la_push_to_start_token, u);
  }
  if (startTokens.size === 0) return false;
  const gid = groupId(i);
  const channelId = await laChannels.openForPrint(bambuUid, gid, "farm");
  let started = false;
  for (const [tok, u] of startTokens) {
    const r = await apns.sendLiveActivityStart(
      tok,
      { printerId: gid, printerName: groupTitle(i) },
      contentState,
      { title: "Your farm is busy", body: `${count} printers in progress` },
      { staleAfterSec: farmStaleAfterSec(contentState), channelId }
    );
    if (r?.success) started = true;
    if (isTokenGone(r)) await clearStartToken(u._id, tok).catch(() => {});
  }
  return started;
}

/** Close the per-printer cards once the farm takes over (one tidy lock screen). */
async function closePrinterCards(bambuUid, users, rows) {
  for (const row of rows) {
    const st = { jobTitle: row.name, progress: row.progress, startTime: row.startTime, endTime: row.endTime, status: row.status, updatedAt: Math.floor(Date.now() / 1000) };
    await laChannels.broadcast(bambuUid, row.devId, "end", st, { priority: 10, dismissAfterSec: 1 });
    for (const u of users || []) {
      const tok = getActivityToken(u, row.devId);
      if (!tok) continue;
      await apns.sendLiveActivityEnd(tok, st, 1);
      await clearActivityToken(String(u._id), row.devId);
    }
  }
}

/**
 * Bring the account's farm cards in line with what is printing: start cards
 * that are needed, update changed ones (or all, on a tick), end empty ones.
 */
async function sync({ bambuUid, users, states, names, now = Date.now(), tickOnly = false }) {
  const uid = String(bambuUid);
  const rows = farmRows(states, names);
  const { groups, overflow } = farmGroups(rows);
  const known = await loadKnown(uid);
  const before = [...known.keys()].sort().join(",");

  let any = false;
  for (let i = 0; i < groups.length; i++) {
    const gid = groupId(i);
    const g = groups[i];
    const sig = signature(g);
    const cs = farmContentState(g, i === groups.length - 1 ? overflow : 0);
    const entry = known.get(gid);
    if (!entry) {
      if (await startGroup(uid, users, i, cs, rows.length)) {
        known.set(gid, { lastPushAt: now, lastSig: sig });
        any = true;
      }
      continue;
    }
    const changed = entry.lastSig !== sig;
    // State changes push only the cards whose printers changed; progress
    // ticks also refresh unchanged cards, at most every 3 min.
    if (!changed && (!tickOnly || now - entry.lastPushAt < TICK_MIN_MS)) continue;
    await pushGroup(uid, users, gid, "update", cs, { priority: changed ? 10 : 5 });
    known.set(gid, { lastPushAt: now, lastSig: sig });
    any = true;
  }
  // Cards no longer needed (printers finished): end them.
  for (const gid of [...known.keys()]) {
    const idx = gid === FARM_ID ? 0 : Number(gid.slice(FARM_ID.length)) - 1;
    if (idx < groups.length) continue;
    const done = { ...farmContentState([]), jobTitle: "All prints done", status: "finished" };
    await pushGroup(uid, users, gid, "end", done, { dismissAfterSec: idx === 0 ? 15 * 60 : 60 });
    known.delete(gid);
    any = true;
  }
  if (known.size) live.set(uid, known);
  else live.delete(uid);
  if ([...known.keys()].sort().join(",") !== before) await saveKnown(uid, known);
  return any;
}

/**
 * Print start. Returns true when the farm handles it — the caller must then
 * NOT start a per-printer card.
 */
async function handleStart({ bambuUid, users, states, names }) {
  if (!apns.isConfigured()) return false;
  const uid = String(bambuUid);
  const wasLive = await isLive(uid);
  const rows = farmRows(states, names);
  // Old app builds can't render farm cards or send their tokens: keep them on
  // per-printer cards.
  if (!wasLive && (rows.length < threshold() || !farmCapable(users))) return false;
  const ok = await sync({ bambuUid: uid, users, states, names });
  if (!wasLive) {
    if (!(live.get(uid)?.size > 0)) return false; // couldn't start: fall back to a printer card
    log.info(`[LA-FARM] started for ${uid} (${rows.length} printers)`);
    await closePrinterCards(uid, users, rows);
  }
  return ok || wasLive;
}

/** A printer changed state (paused/resumed/finished/failed). */
async function refresh({ bambuUid, users, states, names }) {
  if (!apns.isConfigured() || !(await isLive(bambuUid))) return false;
  return sync({ bambuUid, users, states, names });
}

/** Progress tick: each card at most every 3 min (priority 5), or at once if it changed. */
async function tick({ bambuUid, users, states, names, now = Date.now() }) {
  if (!apns.isConfigured() || !(await isLive(bambuUid))) return false;
  return sync({ bambuUid, users, states, names, now, tickOnly: true });
}

function _reset() {
  live.clear();
  notLiveUntil.clear();
}

module.exports = { FARM_ID, isLive, handleStart, refresh, tick, farmRows, farmGroups, farmContentState, threshold, _reset };
