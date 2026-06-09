const express = require("express");
const rateLimit = require("express-rate-limit");
const wsManager = require("../services/wsManager");

const router = express.Router();

/**
 * Public camera feed endpoints.
 * Only serves frames for the user ID set in PUBLIC_CAMERA_UID env var.
 * No API key required — these are meant to be embedded on public websites.
 */

const ALLOWED_UID = process.env.PUBLIC_CAMERA_UID;

// Printer ID prefixes to exclude from public feed (A1s)
const EXCLUDED_PREFIXES = ["03919D"];

// Per-IP rate limits. Generous enough for a public embed showing several
// cameras at ~1 Hz, tight enough that a single abuser/scraper can't pull
// frames in a hot loop. Server-side frames only update every ~2s anyway.
const frameLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 360, // ≈6 req/s sustained per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests" },
});

const listLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests" },
});

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
router.get("/public/cameras", listLimiter, checkUid, (_req, res) => {
  const printerIds = wsManager.getAvailableCameras(ALLOWED_UID)
    .filter((id) => !EXCLUDED_PREFIXES.some((p) => id.startsWith(p)));
  const bridgeOnline = wsManager.isBridgeConnected(ALLOWED_UID);
  res.set("Cache-Control", "public, max-age=5");
  res.json({ ok: true, bridgeOnline, printers: printerIds });
});

// Cheap, stable per-frame ETag — bytes change each frame so length + tail
// bytes are unique enough for freshness comparison. Avoids hashing the
// whole JPEG on every request.
function frameEtag(buf) {
  const len = buf.length;
  const tail = buf.length >= 8 ? buf.slice(buf.length - 8).toString("hex") : "";
  return `W/"${len}-${tail}"`;
}

// GET /api/public/cameras/:printerId/frame — latest JPEG frame
router.get("/public/cameras/:printerId/frame", frameLimiter, checkUid, (req, res) => {
  const frame = wsManager.getLatestFrame(ALLOWED_UID, req.params.printerId);
  if (!frame) {
    return res.status(404).json({ ok: false, error: "No frame available" });
  }

  const etag = frameEtag(frame);
  // Conditional GET — repeat callers with the same frame get a 0-byte 304
  // instead of the full ~150 KB JPEG. This is the bulk of public-feed
  // bandwidth savings since clients typically poll ~1 Hz but frames only
  // update every ~2s.
  if (req.headers["if-none-match"] === etag) {
    res.set({
      "ETag": etag,
      "Cache-Control": "public, max-age=2, must-revalidate",
    });
    return res.status(304).end();
  }

  res.set({
    "Content-Type": "image/jpeg",
    // Brief cache window: lets CDN / browser collapse rapid duplicate hits
    // while keeping freshness within one frame interval. must-revalidate
    // forces conditional GETs once stale, so the ETag path stays hot.
    "Cache-Control": "public, max-age=2, must-revalidate",
    "ETag": etag,
    "Access-Control-Allow-Origin": "*",
  });
  res.send(frame);
});

module.exports = router;
