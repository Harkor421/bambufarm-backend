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

module.exports = router;
