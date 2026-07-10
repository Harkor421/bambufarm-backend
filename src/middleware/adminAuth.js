const crypto = require("crypto");
const { adminPassword } = require("../config");

// Constant-time string compare — avoids leaking the admin password one byte at a
// time via response-timing on the `!==` short-circuit.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireAdmin(req, res, next) {
  if (!adminPassword) return res.status(503).json({ ok: false, error: "Admin not configured" });
  // Accept the password from header (preferred), JSON body, or query string.
  // NOTE: query-string auth leaks the secret into access logs — it is retained
  // ONLY because the admin dashboard loads camera frames via <img src=...> tags
  // (which cannot set headers). TODO: replace <img> auth with short-lived signed
  // frame URLs, then drop req.query?.password.
  const password = req.headers["x-admin-password"] || req.body?.password || req.query?.password;
  if (!safeEqual(password, adminPassword)) {
    return res.status(403).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

module.exports = requireAdmin;
