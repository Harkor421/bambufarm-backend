const express = require("express");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const log = require("./utils/logger");
const requireApiKey = require("./middleware/apiKey");
const healthRoutes = require("./routes/health");
const registerRoutes = require("./routes/register");
const bridgeRoutes = require("./routes/bridge");
const printerControlRoutes = require("./routes/printerControl");
const publicCameraRoutes = require("./routes/publicCamera");
const printVisionRoutes = require("./routes/printVision");
const adminRoutes = require("./routes/admin");
const adminMetricsRoutes = require("./routes/adminMetrics");

const app = express();

// Railway runs behind a reverse proxy — trust X-Forwarded-For for rate limiting
app.set("trust proxy", 1);

// Compress all HTTP responses (saves ~40-60 GB/month egress)
app.use(compression());

// Skip Helmet and rate limit for public camera endpoints (need cross-origin access + high request volume)
app.use("/api/public", (req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// CORS for admin metrics — accessed from the WhatsApp admin frontend (different origin).
// Auth is enforced by the admin password middleware on each route; CORS is just permission
// for the browser to read the response.
//
// Cross-Origin-Resource-Policy must be "cross-origin" so <img> tags on a different
// domain can load camera frames (Helmet defaults to "same-origin" which blocks them).
app.use("/api/admin/metrics", (req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": req.headers.origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Admin-Password",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Vary": "Origin",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// CORS for bambufarm.app on all routes
const ALLOWED_ORIGINS = ["https://bambufarm.app", "https://www.bambufarm.app"];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Api-Key",
    });
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

// Security headers (skip for public + admin metrics routes — they need cross-origin
// image loads which Helmet's default CORP=same-origin blocks).
app.use((req, res, next) => {
  if (req.path.startsWith("/api/public/")) return next();
  if (req.path.startsWith("/api/admin/metrics/")) return next();
  helmet()(req, res, next);
});

// Rate limiting (skip for public routes — they have their own lighter limits)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests, try again later" },
});

// Admin-metrics brute-force guard. This surface is exempt from the API key and
// the global limiter (the admin dashboard polls it heavily, incl. live camera
// <img> frames), so the ONLY protection for the user PII behind it is the admin
// password — with no throttle it could be brute-forced at full request rate.
// Count ONLY 403s (wrong password) toward the limit: successful dashboard
// traffic (200s) and empty-frame 404s are skipped, so the dashboard is never
// throttled while wrong-password attempts are capped per IP.
const adminMetricsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 403,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many attempts, try again later" },
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/public/")) return next();
  if (req.path.startsWith("/api/printer/mqtt-state")) return next();
  if (req.path.startsWith("/api/admin/metrics/")) return adminMetricsLimiter(req, res, next);
  globalLimiter(req, res, next);
});

// Body parsing with size limit
app.use(express.json({ limit: "10kb" }));

// API key authentication (skips /api/health)
app.use(requireApiKey);

// Routes
app.use("/api", healthRoutes);
app.use("/api", registerRoutes);
app.use("/api", bridgeRoutes);
app.use("/api", printerControlRoutes);
app.use("/api", publicCameraRoutes);
app.use("/api", printVisionRoutes);
app.use("/api", adminRoutes);
app.use("/api", adminMetricsRoutes);

// Global error handler. Honor err.status/err.statusCode so body-parser's client
// errors surface with the right code — malformed JSON as 400 and oversized
// bodies (>10kb) as 413 — instead of masquerading as 500. Only genuine 5xx are
// logged at error (with stack); client 4xx log at warn so a stream of malformed
// requests can't pollute 5xx alerting.
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    log.error("[EXPRESS]", err.stack || err.message);
  } else {
    log.warn(`[EXPRESS] ${status} ${req.method} ${req.path}: ${err.message}`);
  }
  res.status(status).json({
    ok: false,
    error: status >= 500 ? "Internal server error" : err.message || "Bad request",
  });
});

// Surface unhandled promise rejections + uncaught exceptions in the logs
// instead of letting them disappear silently.
process.on("unhandledRejection", (reason) => {
  log.error("[UNHANDLED]", reason?.stack || reason);
});
process.on("uncaughtException", (err) => {
  log.error("[UNCAUGHT]", err?.stack || err);
});

module.exports = app;
