const { Router } = require("express");
const User = require("../db/models/User");
const log = require("../utils/logger");

const router = Router();

// --- Input validation helpers ---
const EXPO_TOKEN_RE = /^ExponentPushToken\[[a-zA-Z0-9_-]{20,50}\]$/;
const PRINTER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const HEX_TOKEN_RE = /^[a-f0-9]{20,200}$/i;

function isValidExpoToken(t) {
  return typeof t === "string" && EXPO_TOKEN_RE.test(t);
}
function isValidPrinterId(id) {
  return typeof id === "string" && PRINTER_ID_RE.test(id);
}
function isValidHexToken(t) {
  return typeof t === "string" && HEX_TOKEN_RE.test(t);
}

// POST /api/register
router.post("/register", async (req, res) => {
  try {
    const { expoPushToken, accessToken, refreshToken, expiresAt, laPushToStartToken } = req.body;

    if (!isValidExpoToken(expoPushToken)) {
      return res.status(400).json({ ok: false, error: "Invalid expoPushToken format" });
    }
    if (typeof accessToken !== "string" || accessToken.length < 10) {
      return res.status(400).json({ ok: false, error: "Invalid accessToken" });
    }
    if (typeof refreshToken !== "string" || refreshToken.length < 10) {
      return res.status(400).json({ ok: false, error: "Invalid refreshToken" });
    }
    if (typeof expiresAt !== "number") {
      return res.status(400).json({ ok: false, error: "Invalid expiresAt" });
    }
    // Accept expired tokens — server will refresh them via tokenRefresh service

    // Resolve Bambu UID for cross-device notification routing
    let bambuUid = null;
    try {
      const axios = require("axios");
      const profile = await axios.get("https://api.bambulab.com/v1/user-service/my/profile", {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 5000,
      });
      bambuUid = String(profile.data.uid);
    } catch {}

    const update = {
      bambu_access_token: accessToken,
      bambu_refresh_token: refreshToken,
      bambu_token_expires_at: expiresAt,
      fail_count: 0,
    };
    if (bambuUid) update.bambu_uid = bambuUid;

    if (laPushToStartToken) {
      if (!isValidHexToken(laPushToStartToken)) {
        return res.status(400).json({ ok: false, error: "Invalid laPushToStartToken format" });
      }
      update.la_push_to_start_token = laPushToStartToken;
    }

    await User.findOneAndUpdate(
      { expo_push_token: expoPushToken },
      update,
      { upsert: true, new: true }
    );

    log.info(`[REGISTER] ${expoPushToken.slice(0, 30)}...`);
    res.json({ ok: true });
  } catch (err) {
    log.error(`[REGISTER] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: "Registration failed" });
  }
});

// POST /api/unregister
router.post("/unregister", async (req, res) => {
  try {
    const { expoPushToken } = req.body;

    if (!isValidExpoToken(expoPushToken)) {
      return res.status(400).json({ ok: false, error: "Invalid expoPushToken format" });
    }

    const result = await User.deleteOne({ expo_push_token: expoPushToken });
    log.info(`[UNREGISTER] ${expoPushToken.slice(0, 30)}... (deleted: ${result.deletedCount})`);
    res.json({ ok: true });
  } catch (err) {
    log.error(`[UNREGISTER] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: "Unregistration failed" });
  }
});

// POST /api/activity-token — store an ActivityKit update token for a specific printer
router.post("/activity-token", async (req, res) => {
  try {
    const { expoPushToken, printerId, activityUpdateToken } = req.body;

    if (!isValidExpoToken(expoPushToken)) {
      return res.status(400).json({ ok: false, error: "Invalid expoPushToken format" });
    }
    if (!isValidPrinterId(printerId)) {
      return res.status(400).json({ ok: false, error: "Invalid printerId format" });
    }
    if (!isValidHexToken(activityUpdateToken)) {
      return res.status(400).json({ ok: false, error: "Invalid activityUpdateToken format" });
    }

    await User.findOneAndUpdate(
      { expo_push_token: expoPushToken },
      { [`la_activity_tokens.${printerId}`]: activityUpdateToken }
    );

    log.info(`[ACTIVITY-TOKEN] Stored token for printer ${printerId} (${activityUpdateToken.slice(0, 16)}...)`);
    res.json({ ok: true });
  } catch (err) {
    log.error(`[ACTIVITY-TOKEN] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: "Failed to store activity token" });
  }
});

// POST /api/push-to-start-token — store the ActivityKit push-to-start token
router.post("/push-to-start-token", async (req, res) => {
  try {
    const { expoPushToken, laPushToStartToken } = req.body;

    if (!isValidExpoToken(expoPushToken)) {
      return res.status(400).json({ ok: false, error: "Invalid expoPushToken format" });
    }
    if (!isValidHexToken(laPushToStartToken)) {
      return res.status(400).json({ ok: false, error: "Invalid laPushToStartToken format" });
    }

    await User.findOneAndUpdate(
      { expo_push_token: expoPushToken },
      { la_push_to_start_token: laPushToStartToken }
    );

    log.info(`[PUSH-TO-START] Stored token (${laPushToStartToken.slice(0, 16)}...)`);
    res.json({ ok: true });
  } catch (err) {
    log.error(`[PUSH-TO-START] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: "Failed to store push-to-start token" });
  }
});

// POST /api/admin/broadcast — send a push notification to all users
const ADMIN_PASSWORD = "Starship694201969@";

router.post("/admin/broadcast", async (req, res) => {
  try {
    const { password, title, body, data } = req.body;

    if (password !== ADMIN_PASSWORD) {
      return res.status(403).json({ ok: false, error: "Unauthorized" });
    }
    if (!title || !body) {
      return res.status(400).json({ ok: false, error: "title and body are required" });
    }

    const { sendPush } = require("../services/pushSender");
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

module.exports = router;
