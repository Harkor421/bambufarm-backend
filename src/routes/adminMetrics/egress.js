const requireAdmin = require("../../middleware/adminAuth");
const egressMeter = require("../../services/egressMeter");

/**
 * GET /api/admin/metrics/egress
 * Bytes this process has sent since boot, by category (WS app state, WS
 * frames, HTTP routes…), with a GB/day projection. See services/egressMeter.
 */
module.exports = (router) => {
  router.get("/admin/metrics/egress", requireAdmin, (_req, res) => {
    res.json({ ok: true, ...egressMeter.snapshot() });
  });
};
