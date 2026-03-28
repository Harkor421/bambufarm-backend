const { Router } = require("express");
const wsManager = require("../services/wsManager");
const PrinterState = require("../db/models/PrinterState");
const log = require("../utils/logger");

const router = Router();

// GET /api/bridge/status?userId=xxx — check if a bridge is online for this user
router.get("/bridge/status", (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ ok: false, error: "Missing userId" });
  }

  res.json({
    ok: true,
    connected: wsManager.isBridgeConnected(userId),
  });
});

// GET /api/printer-states — notification-driven printer states
// Auth: pass expoPushToken to identify the user (same token used for registration)
router.get("/printer-states", async (req, res) => {
  const { expoPushToken } = req.query;
  if (!expoPushToken) {
    return res.status(400).json({ ok: false, error: "Missing expoPushToken" });
  }

  try {
    const User = require("../db/models/User");
    const user = await User.findOne({ expo_push_token: expoPushToken }).lean();
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const states = await PrinterState.find({ user_id: user._id }).lean();
    const result = {};
    for (const s of states) {
      if (s.notif_status && s.notif_status !== "idle") {
        result[s.printer_dev_id] = {
          status: s.notif_status,
          jobTitle: s.notif_job_title,
          startedAt: s.notif_started_at,
          costTimeSec: s.notif_cost_time_sec,
          pausedAt: s.notif_paused_at,
          frozenRemainingSec: s.notif_frozen_remaining_sec,
          frozenProgressPct: s.notif_frozen_progress_pct,
          taskId: s.notif_task_id,
        };
      }
    }
    res.json({ ok: true, printers: result });
  } catch (err) {
    log.error(`[API] printer-states error: ${err.message}`);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

module.exports = router;
