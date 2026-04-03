const { Router } = require("express");
const PrintAnalysis = require("../db/models/PrintAnalysis");
const log = require("../utils/logger");

const router = Router();

// GET /api/vision/history/:printerId — last N analyses for a printer
router.get("/vision/history/:printerId", async (req, res) => {
  try {
    const { printerId } = req.params;
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const analyses = await PrintAnalysis.find({ printer_dev_id: printerId })
      .sort({ analyzed_at: -1 })
      .limit(limit)
      .lean();

    res.json({ ok: true, analyses });
  } catch (err) {
    log.error(`[VISION] History error: ${err.message}`);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// GET /api/vision/status — current monitoring status
router.get("/vision/status", async (req, res) => {
  try {
    const enabled = process.env.VISION_ENABLED === "true";
    const targetUid = process.env.VISION_TARGET_UID || null;

    // Get latest analysis per printer (last 10 minutes)
    const recent = await PrintAnalysis.find({
      analyzed_at: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
    })
      .sort({ analyzed_at: -1 })
      .lean();

    // Group by printer, take latest
    const byPrinter = {};
    for (const a of recent) {
      if (!byPrinter[a.printer_dev_id]) {
        byPrinter[a.printer_dev_id] = {
          printerId: a.printer_dev_id,
          verdict: a.verdict,
          confidence: a.confidence,
          issues: a.issues,
          detail: a.detail,
          analyzedAt: a.analyzed_at,
          subtaskName: a.subtask_name,
          mcPercent: a.mc_percent,
        };
      }
    }

    res.json({
      ok: true,
      enabled,
      targetUid,
      model: "claude-sonnet-4-5-20251001",
      printers: Object.values(byPrinter),
    });
  } catch (err) {
    log.error(`[VISION] Status error: ${err.message}`);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// POST /api/vision/test-broadcast — test sending a camera snapshot to Tecnoprints
// Body: { printerId, uid?, message? }
router.post("/vision/test-broadcast", async (req, res) => {
  try {
    const { printerId, uid, message } = req.body;
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const bambuUid = uid || process.env.VISION_TARGET_UID || "1789751384";
    const wsManager = require("../services/wsManager");
    const axios = require("axios");

    // Get frame
    const frame = wsManager.getLatestFrame(bambuUid, printerId);
    const frameInfo = frame ? `${frame.length} bytes` : "NO FRAME";
    log.info(`[VISION-TEST] Frame for ${printerId} (uid=${bambuUid}): ${frameInfo}`);

    const msg = message || `🧪 Test broadcast for ${printerId} — frame: ${frameInfo}`;

    const FormData = require("form-data");
    const form = new FormData();
    form.append("message", msg);
    if (frame && frame.length > 100) {
      form.append("media", frame, { filename: `${printerId}.jpg`, contentType: "image/jpeg" });
    }

    const r = await axios.post(
      "https://backend-production-b1e9.up.railway.app/api/broadcast/tecnoprints",
      form,
      { headers: form.getHeaders(), timeout: 10000 }
    );

    res.json({
      ok: true,
      frameBytes: frame?.length || 0,
      hasFrame: !!(frame && frame.length > 100),
      broadcastStatus: r.status,
      message: msg,
    });
  } catch (err) {
    log.error(`[VISION-TEST] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
