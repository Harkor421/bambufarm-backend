const { Router } = require("express");
const User = require("../db/models/User");
const PrinterState = require("../db/models/PrinterState");
const requireAdmin = require("../middleware/adminAuth");
const { sendPush } = require("../services/pushSender");
const log = require("../utils/logger");

const router = Router();

// POST /api/admin/broadcast — send a push notification to all users
router.post("/admin/broadcast", requireAdmin, async (req, res) => {
  try {
    const { title, body, data } = req.body;
    if (!title || !body) {
      return res.status(400).json({ ok: false, error: "title and body are required" });
    }

    const users = await User.find({ expo_push_token: { $exists: true, $ne: null } }).lean();

    let sent = 0;
    let failed = 0;
    for (const u of users) {
      try {
        await sendPush(u.expo_push_token, {
          title,
          body,
          data: { type: "admin_broadcast", ...(data || {}) },
        });
        sent++;
      } catch {
        failed++;
      }
    }

    log.info(`[ADMIN] Broadcast sent: ${sent} delivered, ${failed} failed, "${title}"`);
    res.json({ ok: true, sent, failed, total: users.length });
  } catch (err) {
    log.error(`[ADMIN] Broadcast error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/stats — platform stats
router.get("/admin/stats", requireAdmin, async (req, res) => {
  try {
    const wsManager = require("../services/wsManager");

    const totalUsers = await User.countDocuments();
    const uniqueAccounts = await User.distinct("bambu_uid", { bambu_uid: { $ne: null } });
    const laUsers = await User.countDocuments({ la_push_to_start_token: { $ne: null } });
    const usersWithActivityTokens = await User.countDocuments({ "la_activity_tokens": { $exists: true, $ne: {} } });

    const printerCounts = await PrinterState.aggregate([
      { $group: { _id: "$user_id", count: { $sum: 1 } } },
      { $group: {
        _id: null,
        totalPrinters: { $sum: "$count" },
        avgPerUser: { $avg: "$count" },
        maxPerUser: { $max: "$count" },
        minPerUser: { $min: "$count" },
        userCount: { $sum: 1 },
      }},
    ]);

    const uniquePrinters = await PrinterState.distinct("printer_dev_id");
    const printing = await PrinterState.countDocuments({ notif_status: "printing" });
    const paused = await PrinterState.countDocuments({ notif_status: "paused" });

    let bridgeCount = 0;
    try {
      if (wsManager.bridges) {
        for (const [, userBridges] of wsManager.bridges) {
          bridgeCount += userBridges.size || userBridges.length || 0;
        }
      }
    } catch {}

    const deviceBuckets = await PrinterState.aggregate([
      { $group: { _id: "$user_id", count: { $sum: 1 } } },
      { $bucket: {
        groupBy: "$count",
        boundaries: [1, 2, 3, 5, 10, 20, 50],
        default: "50+",
        output: { users: { $sum: 1 } },
      }},
    ]);

    const stats = printerCounts[0] || {};

    res.json({
      ok: true,
      users: {
        totalRegistered: totalUsers,
        uniqueBambuAccounts: uniqueAccounts.length,
        withLiveActivities: laUsers,
        withActivityTokens: usersWithActivityTokens,
      },
      printers: {
        uniqueDevices: uniquePrinters.length,
        totalRecords: stats.totalPrinters || 0,
        avgPerUser: Math.round((stats.avgPerUser || 0) * 10) / 10,
        maxPerUser: stats.maxPerUser || 0,
        currentlyPrinting: printing,
        currentlyPaused: paused,
      },
      bridges: bridgeCount,
      printerDistribution: deviceBuckets,
    });
  } catch (err) {
    log.error(`[ADMIN] Stats error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
