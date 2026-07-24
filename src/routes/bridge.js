const { Router } = require("express");
const wsManager = require("../services/wsManager");
const PrinterState = require("../db/models/PrinterState");
const { getUserByPushToken } = require("../services/userTokenCache");
const log = require("../utils/logger");

const router = Router();

// GET /api/bridge/status?userId=xxx&expoPushToken=yyy — is a bridge online for this user
//
// SECURITY: userId is a Bambu uid taken from the query. Without an ownership
// check, any shared-API-key holder could enumerate arbitrary uids and learn
// whether each account has a local bridge online. The sibling endpoints
// (printer/frame, mqtt-state, all control) require expoPushToken + verify
// ownership; this one was missed. Require the caller's token and confirm the
// requested uid is their OWN account.
router.get("/bridge/status", async (req, res) => {
  const { userId, expoPushToken } = req.query;
  if (!userId) {
    return res.status(400).json({ ok: false, error: "Missing userId" });
  }
  if (!expoPushToken) {
    return res.status(401).json({ ok: false, error: "Missing expoPushToken" });
  }

  const user = await getUserByPushToken(expoPushToken);
  if (!user || String(user.bambu_uid) !== String(userId)) {
    return res.status(403).json({ ok: false, error: "Unauthorized" });
  }

  res.json({
    ok: true,
    connected: wsManager.isBridgeConnected(userId),
  });
});

// GET /api/printer/frame/:uid/:printerId — latest camera frame as JPEG.
//
// SECURITY: the camera frame for a printer is private. This endpoint previously
// returned the latest JPEG for ANY uid+printerId behind only the shared API
// key, so anyone who enumerated device IDs could pull a stranger's live camera.
// Require the caller's expoPushToken and verify the requested uid is the
// caller's OWN Bambu account before returning any frame.
router.get("/printer/frame/:uid/:printerId", async (req, res) => {
  try {
    const { uid, printerId } = req.params;
    const { expoPushToken } = req.query;
    if (!expoPushToken) return res.status(401).end();

    const user = await getUserByPushToken(expoPushToken);
    if (!user || String(user.bambu_uid) !== String(uid)) {
      return res.status(403).end();
    }

    const frame = wsManager.getLatestFrame(uid, printerId);
    if (!frame) {
      return res.status(404).end();
    }
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "no-store");
    res.send(frame);
  } catch (err) {
    log.error(`[API] frame error: ${err.message}`);
    res.status(500).end();
  }
});

// GET /api/printer-states — notification-driven printer states
// Auth: pass expoPushToken to identify the user (same token used for registration)
router.get("/printer-states", async (req, res) => {
  const { expoPushToken } = req.query;
  if (!expoPushToken) {
    return res.status(400).json({ ok: false, error: "Missing expoPushToken" });
  }

  try {
    const user = await getUserByPushToken(expoPushToken);
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
