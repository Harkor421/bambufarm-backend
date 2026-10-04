/**
 * Which print we already started a Live Activity for, per account + printer.
 *
 * Why it exists: a card created by push-to-start while the app is closed
 * cannot be updated until the app runs and hands us that activity's update
 * token — iOS does not reliably wake the app for it (measured in prod: ~13% of
 * pushed cards ever register a token). The old fallback "no activity token →
 * push-to-start again" therefore fired on every pause/resume of such a print
 * and STACKED a new card on the lock screen each time, while the earlier ones
 * stayed frozen. Alterna's rule is one card per session; this is that guard.
 *
 * In memory on purpose (same trade-off as Alterna's host cache): after a
 * restart the worst case is ONE extra card for a print already in flight.
 * Bounded by printers actually printing; entries expire with Apple's own 8h
 * Live Activity lifetime (+ margin).
 */

const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 50000;

/** key `${bambuUid}:${devId}` → { printKey, at } */
const started = new Map();

function keyOf(bambuUid, devId) {
  return `${bambuUid}:${devId}`;
}

/** A stable identity for "this print": task id when Bambu sends one, else the file name. */
function printKeyOf(state) {
  if (!state) return null;
  const task = state.task_id && String(state.task_id) !== "0" ? String(state.task_id) : null;
  return task || state.subtask_name || null;
}

/**
 * Has a card already been started for this exact print? Unknown print
 * identity counts as "not started" so we never suppress the first card.
 */
function alreadyStarted(bambuUid, devId, printKey, now = Date.now()) {
  if (!printKey) return false;
  const e = started.get(keyOf(bambuUid, devId));
  if (!e) return false;
  if (now - e.at > TTL_MS) {
    started.delete(keyOf(bambuUid, devId));
    return false;
  }
  return e.printKey === printKey;
}

function recordStart(bambuUid, devId, printKey, now = Date.now()) {
  if (started.size >= MAX_ENTRIES) started.clear();
  started.set(keyOf(bambuUid, devId), { printKey: printKey || null, at: now });
}

/** Seconds since we last started a card on this printer for this account, or null. */
function secondsSinceStart(bambuUid, devId, now = Date.now()) {
  const e = started.get(keyOf(bambuUid, devId));
  if (!e || now - e.at > TTL_MS) return null;
  return Math.round((now - e.at) / 1000);
}

function clear(bambuUid, devId) {
  started.delete(keyOf(bambuUid, devId));
}

function _reset() {
  started.clear();
}

module.exports = { printKeyOf, alreadyStarted, recordStart, secondsSinceStart, clear, _reset };
