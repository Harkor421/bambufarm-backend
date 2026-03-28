const log = require("../utils/logger");

const API_KEY = process.env.API_KEY;

function requireApiKey(req, res, next) {
  if (req.path === "/api/health") return next();
  if (req.path.startsWith("/api/public/")) return next();

  if (!API_KEY) {
    log.error("[AUTH] API_KEY env var not set — rejecting request");
    return res.status(500).json({ ok: false, error: "Server misconfigured" });
  }

  const provided = req.headers["x-api-key"];
  if (!provided || provided !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}

module.exports = requireApiKey;
