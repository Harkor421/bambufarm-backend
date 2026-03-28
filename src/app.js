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

// Security headers (skip for public routes)
app.use((req, res, next) => {
  if (req.path.startsWith("/api/public/")) return next();
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
app.use((req, res, next) => {
  if (req.path.startsWith("/api/public/")) return next();
  if (req.path.startsWith("/api/printer/mqtt-state")) return next();
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

// Global error handler
app.use((err, _req, res, _next) => {
  log.error("[EXPRESS]", err.stack || err.message);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

module.exports = app;
