const { Router } = require("express");
const PrintAnalysis = require("../db/models/PrintAnalysis");
const requireAdmin = require("../middleware/adminAuth");
const log = require("../utils/logger");

const router = Router();

// SECURITY: these are operator-only endpoints, NOT user-facing (the
// mobile app never calls /vision/*). They were gated ONLY by the shared,
// app-embedded API key — so any client holding it could POST /vision/test-broadcast
// to read per-printer AI analysis.
// Require the admin password, matching admin.js.
router.use("/vision", requireAdmin);

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
    const cfg = require("../config");
    const enabled = cfg.vision.enabled;
    const targetUid = cfg.vision.targetUid || null;

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
      model: cfg.vision.model,
      printers: Object.values(byPrinter),
    });
  } catch (err) {
    log.error(`[VISION] Status error: ${err.message}`);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

module.exports = router;
