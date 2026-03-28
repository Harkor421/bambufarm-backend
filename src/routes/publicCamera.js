const express = require("express");
const wsManager = require("../services/wsManager");
const log = require("../utils/logger");

const router = express.Router();

/**
 * Public camera feed endpoints.
 * Only serves frames for the user ID set in PUBLIC_CAMERA_UID env var.
 * No API key required — these are meant to be embedded on public websites.
 */

const ALLOWED_UID = process.env.PUBLIC_CAMERA_UID;

// Printer ID prefixes to exclude from public feed (A1s)
const EXCLUDED_PREFIXES = ["03919D"];

function checkUid(req, res, next) {
  if (!ALLOWED_UID) {
    return res.status(503).json({ ok: false, error: "Public camera feed not configured" });
  }
  // Override Helmet's restrictive CORS/CORP headers for public endpoints
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cross-Origin-Opener-Policy": "unsafe-none",
  });
  next();
}

// GET /api/public/cameras — list available camera feeds
router.get("/public/cameras", checkUid, (_req, res) => {
  const printerIds = wsManager.getAvailableCameras(ALLOWED_UID)
    .filter((id) => !EXCLUDED_PREFIXES.some((p) => id.startsWith(p)));
  const bridgeOnline = wsManager.isBridgeConnected(ALLOWED_UID);
  res.json({ ok: true, bridgeOnline, printers: printerIds });
});

// GET /api/public/cameras/:printerId/frame — latest JPEG frame
router.get("/public/cameras/:printerId/frame", checkUid, (req, res) => {
  const frame = wsManager.getLatestFrame(ALLOWED_UID, req.params.printerId);
  if (!frame) {
    return res.status(404).json({ ok: false, error: "No frame available" });
  }
  res.set({
    "Content-Type": "image/jpeg",
    "Cache-Control": "no-cache, no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.send(frame);
});

module.exports = router;
