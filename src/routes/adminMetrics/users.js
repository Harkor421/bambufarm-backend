const User = require("../../db/models/User");
const PrinterState = require("../../db/models/PrinterState");
const BridgeSession = require("../../db/models/BridgeSession");
const requireAdmin = require("../../middleware/adminAuth");
const log = require("../../utils/logger");
const { scheduleEmailBackfill } = require("./_shared");
const { dedupeUsersByBambuUid } = require("../../utils/userDedup");

/**
 * GET /api/admin/metrics/users?limit=100&hasBridge=1
 *   List users with summary info. Optional filter: hasBridge=1 → only users
 *   who have ever connected a BambuBridge.
 *
 * POST /api/admin/metrics/users/backfill-emails
 *   One-shot bulk backfill — iterate ALL users without bambu_email and fetch
 *   their profile. Useful right after deploy to fill in everyone at once.
 */
module.exports = (router) => {
  router.get("/admin/metrics/users", requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const offset = Number(req.query.offset) || 0;
      const hasBridge = req.query.hasBridge === "1";

      let bridgeUids = null;
      if (hasBridge) {
        bridgeUids = new Set(await BridgeSession.distinct("bambu_uid"));
      }

      const query = {};
      if (hasBridge) query.bambu_uid = { $in: [...bridgeUids] };

      // Pull every user matching the filter — we'll dedupe by bambu_uid and
      // paginate AFTER the dedup. We can't dedupe at the DB level because we
      // want to keep the freshest fields (email, tokens) from whichever device
      // was most recently active for that uid.
      const allUsers = await User.find(query)
        .sort({ updatedAt: -1 })
        .select(
          "_id bambu_uid bambu_email bambu_account bambu_name expo_push_token bambu_token_expires_at fail_count la_push_to_start_token createdAt updatedAt"
        )
        .lean();

      // Dedup by bambu_uid: each human gets ONE row even if they registered the
      // app on multiple devices. Shared, unit-tested helper (utils/userDedup).
      const dedupedSorted = dedupeUsersByBambuUid(allUsers);
      const dedupedTotal = dedupedSorted.length;
      const page = dedupedSorted.slice(offset, offset + limit);

      // Pull bridge + printer aggregates ONLY for the visible page.
      const pageUids = page.map((g) => g.rep.bambu_uid).filter(Boolean);
      const pageUserIds = page.flatMap((g) => g.userIds);

      const bridgeAgg = await BridgeSession.aggregate([
        { $match: { bambu_uid: { $in: pageUids } } },
        {
          $group: {
            _id: "$bambu_uid",
            sessionCount: { $sum: 1 },
            lastConnected: { $max: "$connected_at" },
            anyOpen: { $sum: { $cond: [{ $eq: ["$disconnected_at", null] }, 1, 0] } },
          },
        },
      ]);
      const bridgeMap = Object.fromEntries(bridgeAgg.map((b) => [b._id, b]));

      // Printer aggregate: same printer_dev_id can exist under multiple
      // user_ids when the human used multiple devices. Dedupe by (uid, dev_id)
      // pair via a $lookup so the count reflects DISTINCT physical printers.
      const printerAgg = await PrinterState.aggregate([
        { $match: { user_id: { $in: pageUserIds } } },
        { $lookup: { from: "users", localField: "user_id", foreignField: "_id", as: "user" } },
        { $unwind: "$user" },
        {
          $group: {
            _id: { uid: "$user.bambu_uid", dev: "$printer_dev_id" },
            notif_status: { $first: "$notif_status" },
          },
        },
        {
          $group: {
            _id: "$_id.uid",
            printerCount: { $sum: 1 },
            printingCount: {
              $sum: { $cond: [{ $eq: ["$notif_status", "printing"] }, 1, 0] },
            },
            pausedCount: { $sum: { $cond: [{ $eq: ["$notif_status", "paused"] }, 1, 0] } },
          },
        },
      ]);
      const printerMap = Object.fromEntries(printerAgg.map((p) => [p._id, p]));

      // Live: which bambuUids currently have a bridge WS open?
      const wsManager = require("../../services/wsManager");
      const liveBridgeUids = new Set();
      if (wsManager.bridges) {
        for (const [uid, set] of wsManager.bridges) {
          if ((set.size || 0) > 0) liveBridgeUids.add(uid);
        }
      }

      const items = page.map((g) => {
        const u = g.rep;
        const bridge = bridgeMap[u.bambu_uid] || null;
        const printer = printerMap[u.bambu_uid] || null;
        return {
          userId: String(u._id),
          bambuUid: u.bambu_uid,
          email: g.email,
          account: g.account,
          name: g.name,
          deviceCount: g.deviceCount,
          pushTokenTail: u.expo_push_token ? u.expo_push_token.slice(-12) : null,
          tokenExpiresAt: u.bambu_token_expires_at,
          failCount: u.fail_count,
          hasLiveActivities: !!u.la_push_to_start_token,
          registeredAt: g.firstSeen,
          lastSeenAt: u.updatedAt,
          bridge: bridge
            ? {
                sessionCount: bridge.sessionCount,
                lastConnected: bridge.lastConnected,
                currentlyConnected: liveBridgeUids.has(u.bambu_uid),
              }
            : { sessionCount: 0, lastConnected: null, currentlyConnected: false },
          printers: printer
            ? {
                total: printer.printerCount,
                printing: printer.printingCount,
                paused: printer.pausedCount,
              }
            : { total: 0, printing: 0, paused: 0 },
        };
      });

      // Lazy backfill: schedule profile fetches for any visible user missing
      // an email. Doesn't block the response — the next /users poll surfaces
      // the populated emails.
      for (const g of page) {
        if (!g.email) scheduleEmailBackfill(g.rep);
      }

      res.json({ ok: true, total: dedupedTotal, limit, offset, items });
    } catch (err) {
      log.error(`[ADMIN] Users error: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post("/admin/metrics/users/backfill-emails", requireAdmin, async (_req, res) => {
    try {
      const candidates = await User.find({
        bambu_email: { $in: [null, ""] },
        bambu_access_token: { $exists: true, $ne: "" },
      })
        .select("_id bambu_access_token")
        .lean();
      for (const u of candidates) scheduleEmailBackfill(u);
      res.json({ ok: true, queued: candidates.length });
    } catch (err) {
      log.error(`[ADMIN] Backfill error: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};
