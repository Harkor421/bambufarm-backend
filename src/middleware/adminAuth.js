const { adminPassword } = require("../config");

function requireAdmin(req, res, next) {
  if (!adminPassword) return res.status(503).json({ ok: false, error: "Admin not configured" });
  const password = req.body?.password || req.query?.password;
  if (password !== adminPassword) return res.status(403).json({ ok: false, error: "Unauthorized" });
  next();
}

module.exports = requireAdmin;
