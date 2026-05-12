const requireAdmin = require("../../middleware/adminAuth");
const log = require("../../utils/logger");
const { recentActivity, RECENT_ACTIVITY_MAX } = require("./_shared");

/**
 * GET /api/admin/metrics/activity?limit=100
 * Recent state transitions (live feed). In-memory ring buffer, last 200.
 */
module.exports = (router) => {
  router.get("/admin/metrics/activity", requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, RECENT_ACTIVITY_MAX);
      res.json({ ok: true, total: recentActivity.length, items: recentActivity.slice(0, limit) });
    } catch (err) {
      log.error(`[ADMIN] Activity error: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};
