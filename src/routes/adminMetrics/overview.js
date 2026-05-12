const User = require("../../db/models/User");
const PrinterState = require("../../db/models/PrinterState");
const BridgeSession = require("../../db/models/BridgeSession");
const requireAdmin = require("../../middleware/adminAuth");
const log = require("../../utils/logger");
const { recentActivity } = require("./_shared");

/**
 * GET /api/admin/metrics/overview
 * High-level dashboard numbers: users, bridges, currently active prints, etc.
 */
module.exports = (router) => {
  router.get("/admin/metrics/overview", requireAdmin, async (_req, res) => {
    try {
      const wsManager = require("../../services/wsManager");
      const mqttService = require("../../services/mqttPrinterService");

      const now = Date.now();
      const hrs = (h) => new Date(now - h * 60 * 60_000);
      const days = (d) => new Date(now - d * 24 * 60 * 60_000);

      // ── User counts ─────────────────────────────────────────────
      const totalUsers = await User.countDocuments();
      const uniqueAccounts = await User.distinct("bambu_uid", { bambu_uid: { $ne: null } });
      const failedUsers = await User.countDocuments({ fail_count: { $gte: 5 } });
      const usersLastDay = await User.countDocuments({ updatedAt: { $gte: days(1) } });
      const usersLast7d = await User.countDocuments({ updatedAt: { $gte: days(7) } });

      // ── Bridge stats (live + historical) ────────────────────────
      let bridgesConnected = 0;
      const connectedBridgeUids = new Set();
      if (wsManager.bridges) {
        for (const [uid, set] of wsManager.bridges) {
          bridgesConnected += set.size || 0;
          if ((set.size || 0) > 0) connectedBridgeUids.add(uid);
        }
      }
      const bridgesLastHour = (
        await BridgeSession.distinct("bambu_uid", { connected_at: { $gte: hrs(1) } })
      ).length;
      const bridgesLast24h = (
        await BridgeSession.distinct("bambu_uid", { connected_at: { $gte: hrs(24) } })
      ).length;
      const bridgesEverUsed = (await BridgeSession.distinct("bambu_uid")).length;

      // ── App WebSocket clients ───────────────────────────────────
      let appClientsConnected = 0;
      let uniqueAppUids = 0;
      if (wsManager.appClients) {
        for (const [, set] of wsManager.appClients) appClientsConnected += set.size || 0;
        uniqueAppUids = wsManager.appClients.size;
      }

      // ── MQTT printer connections ────────────────────────────────
      let mqttConnections = 0;
      let mqttConnected = 0;
      if (mqttService.connections) {
        mqttConnections = mqttService.connections.size;
        for (const conn of mqttService.connections.values()) {
          if (conn.connected) mqttConnected++;
        }
      }

      // ── Print states ────────────────────────────────────────────
      const totalPrinters = await PrinterState.countDocuments();
      const printing = await PrinterState.countDocuments({ notif_status: "printing" });
      const paused = await PrinterState.countDocuments({ notif_status: "paused" });
      const idle = await PrinterState.countDocuments({ notif_status: "idle" });

      const transitionsLastHour = recentActivity.filter(
        (a) => Date.parse(a.at) >= hrs(1).getTime()
      ).length;
      const transitionsLast24h = recentActivity.filter(
        (a) => Date.parse(a.at) >= hrs(24).getTime()
      ).length;

      res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        users: {
          totalRegistered: totalUsers,
          uniqueBambuAccounts: uniqueAccounts.length,
          failed: failedUsers,
          activeLastDay: usersLastDay,
          activeLast7d: usersLast7d,
        },
        bridges: {
          currentlyConnected: bridgesConnected,
          uniqueUsersConnected: connectedBridgeUids.size,
          activeLastHour: bridgesLastHour,
          activeLast24h: bridgesLast24h,
          everUsed: bridgesEverUsed,
        },
        app: { wsConnections: appClientsConnected, uniqueUsers: uniqueAppUids },
        mqtt: { totalConnections: mqttConnections, connected: mqttConnected },
        printers: { total: totalPrinters, printing, paused, idle },
        activity: {
          transitionsLastHour,
          transitionsLast24h,
          bufferSize: recentActivity.length,
        },
      });
    } catch (err) {
      log.error(`[ADMIN] Overview error: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};
