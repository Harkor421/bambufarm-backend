const User = require("../../db/models/User");
const PrinterState = require("../../db/models/PrinterState");
const requireAdmin = require("../../middleware/adminAuth");
const log = require("../../utils/logger");

/**
 * GET /api/admin/metrics/printers?status=printing&limit=200
 * List every printer with its current state, owner, progress, ETA.
 * Supports filtering by status and pagination via limit/offset.
 */
module.exports = (router) => {
  router.get("/admin/metrics/printers", requireAdmin, async (req, res) => {
    try {
      const status = req.query.status; // "printing" | "paused" | "idle" | undefined
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const offset = Number(req.query.offset) || 0;

      const query = {};
      if (status) query.notif_status = status;

      const total = await PrinterState.countDocuments(query);

      // Sort: printing first, then paused, then by most recent update
      const printers = await PrinterState.find(query)
        .sort({ notif_status: 1, updatedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean();

      // Hydrate with bambu_uid + expo_push_token tail (for cross-referencing)
      const userIds = [...new Set(printers.map((p) => String(p.user_id)))];
      const users = await User.find({ _id: { $in: userIds } })
        .select("_id bambu_uid expo_push_token createdAt")
        .lean();
      const userMap = Object.fromEntries(users.map((u) => [String(u._id), u]));

      // Pull live MQTT state for currently-connected printers (overlays DB state)
      const mqttService = require("../../services/mqttPrinterService");
      const liveStates = new Map();
      if (mqttService.connections) {
        for (const conn of mqttService.connections.values()) {
          if (!conn.printerStates) continue;
          for (const [devId, state] of conn.printerStates) {
            liveStates.set(devId, {
              gcode_state: state.gcode_state,
              mc_percent: state.mc_percent,
              mc_remaining_time: state.mc_remaining_time,
              subtask_name: state.subtask_name,
              layer_num: state.layer_num,
              total_layer_num: state.total_layer_num,
              nozzle_temper: state.nozzle_temper,
              bed_temper: state.bed_temper,
              hms: Array.isArray(state.hms) ? state.hms.length : 0,
            });
          }
        }
      }

      const items = printers.map((p) => {
        const user = userMap[String(p.user_id)] || null;
        const live = liveStates.get(p.printer_dev_id) || null;
        return {
          printerId: p.printer_dev_id,
          printerName: p.printer_name,
          status: p.notif_status,
          jobTitle: p.notif_job_title || p.last_job_title || null,
          startedAt: p.notif_started_at,
          costTimeSec: p.notif_cost_time_sec,
          pausedAt: p.notif_paused_at,
          progressAtPause: p.notif_frozen_progress_pct,
          remainingAtPause: p.notif_frozen_remaining_sec,
          updatedAt: p.updatedAt,
          owner: user
            ? {
                userId: String(user._id),
                bambuUid: user.bambu_uid,
                pushTokenTail: user.expo_push_token ? user.expo_push_token.slice(-12) : null,
                registeredAt: user.createdAt,
              }
            : null,
          live, // live MQTT snapshot (null if MQTT not connected for this printer)
        };
      });

      res.json({ ok: true, total, limit, offset, items });
    } catch (err) {
      log.error(`[ADMIN] Printers error: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};
