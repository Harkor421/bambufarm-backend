/**
 * Per-account cache of the user records the Live Activity progress path needs.
 *
 * The progress cadence now pushes every few minutes per printing printer (not
 * just at 20% milestones), and each push used to run its own
 * `User.find({ bambu_uid })`. This keeps the same answer for 60s.
 *
 * 60s and not "until reconnect": update tokens register MID-print, so the
 * cache must notice them — `invalidate()` is called from POST
 * /api/activity-token, and the TTL bounds any other path.
 */
const User = require("../db/models/User");

const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 20000;
const cache = new Map(); // bambuUid → { at, users }

async function getUsers(bambuUid, now = Date.now()) {
  const key = String(bambuUid);
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.users;
  const users = await User.find(
    { bambu_uid: key, fail_count: { $lt: 5 } },
    { _id: 1, bambu_uid: 1, la_activity_tokens: 1 }
  ).lean();
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { at: now, users });
  return users;
}

function invalidate(bambuUid) {
  if (bambuUid != null) cache.delete(String(bambuUid));
}

function _reset() {
  cache.clear();
}

module.exports = { getUsers, invalidate, _reset };
