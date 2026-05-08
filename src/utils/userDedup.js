/**
 * Group a list of User documents by `bambu_uid` so the admin metrics
 * page shows ONE row per human even when they registered the app on
 * multiple devices (each device = its own User document).
 *
 * The most recently active device wins as the "representative" row,
 * and we fall back across devices for fields that might be missing on
 * the rep — older devices that registered before bambu_email landed
 * in the schema have null on that field, but a newer device on the
 * same uid often has it.
 *
 * Users with NO bambu_uid (Bambu auth failed at register) keep their
 * own group keyed by _id so they don't all collapse into a single
 * "no-uid" bucket.
 *
 * @param {Array<{_id, bambu_uid?, bambu_email?, bambu_account?, bambu_name?, createdAt, updatedAt}>} users
 *   Already sorted by `updatedAt` desc — the first occurrence of each
 *   uid is the rep.
 * @returns {Array<{rep, deviceCount, firstSeen, userIds, email, account, name}>}
 *   Ordered by rep.updatedAt desc.
 */
function dedupeUsersByBambuUid(users) {
  const groups = new Map();
  for (const u of users) {
    const key = u.bambu_uid || `__nouid__${u._id}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        rep: u,
        deviceCount: 1,
        firstSeen: u.createdAt,
        userIds: [u._id],
        email: u.bambu_email || null,
        account: u.bambu_account || null,
        name: u.bambu_name || null,
      });
    } else {
      g.deviceCount += 1;
      g.userIds.push(u._id);
      if (u.createdAt && (!g.firstSeen || u.createdAt < g.firstSeen)) {
        g.firstSeen = u.createdAt;
      }
      if (!g.email && u.bambu_email) g.email = u.bambu_email;
      if (!g.account && u.bambu_account) g.account = u.bambu_account;
      if (!g.name && u.bambu_name) g.name = u.bambu_name;
    }
  }
  return [...groups.values()].sort(
    (a, b) => new Date(b.rep.updatedAt) - new Date(a.rep.updatedAt)
  );
}

module.exports = { dedupeUsersByBambuUid };
