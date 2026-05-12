const User = require("../../db/models/User");
const BridgeSession = require("../../db/models/BridgeSession");
const requireAdmin = require("../../middleware/adminAuth");
const log = require("../../utils/logger");

/**
 * GET /api/admin/metrics/bridges
 * Currently-connected bridges with uid, connected-since, owner info.
 */
module.exports = (router) => {
  router.get("/admin/metrics/bridges", requireAdmin, async (_req, res) => {
    try {
      const wsManager = require("../../services/wsManager");
      const items = [];

      if (wsManager.bridges) {
        const uids = [...wsManager.bridges.keys()];
        // Find the matching open BridgeSession for each connected uid
        const openSessions = await BridgeSession.find({
          bambu_uid: { $in: uids },
          disconnected_at: null,
        })
          .sort({ connected_at: -1 })
          .lean();
        const sessionMap = {};
        for (const s of openSessions) {
          if (!sessionMap[s.bambu_uid]) sessionMap[s.bambu_uid] = s;
        }

        // Look up the user record(s) for each uid
        const users = await User.find({ bambu_uid: { $in: uids } })
          .select("_id bambu_uid expo_push_token createdAt")
          .lean();
        const userMap = {};
        for (const u of users) {
          if (!userMap[u.bambu_uid]) userMap[u.bambu_uid] = u;
        }

        for (const [uid, set] of wsManager.bridges) {
          const session = sessionMap[uid];
          const user = userMap[uid];
          items.push({
            bambuUid: uid,
            connectionCount: set.size || 0,
            connectedAt: session ? session.connected_at : null,
            owner: user
              ? {
                  userId: String(user._id),
                  pushTokenTail: user.expo_push_token ? user.expo_push_token.slice(-12) : null,
                  registeredAt: user.createdAt,
                }
              : null,
          });
        }
      }

      items.sort(
        (a, b) =>
          (b.connectedAt ? Date.parse(b.connectedAt) : 0) -
          (a.connectedAt ? Date.parse(a.connectedAt) : 0)
      );

      res.json({ ok: true, total: items.length, items });
    } catch (err) {
      log.error(`[ADMIN] Bridges error: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};
