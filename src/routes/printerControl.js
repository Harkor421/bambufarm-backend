const { Router } = require("express");
const mqttService = require("../services/mqttPrinterService");
const User = require("../db/models/User");
const log = require("../utils/logger");

const router = Router();

// Resolve user — try expoPushToken first, then find by printerId in MQTT connections
async function resolveUser(req, res) {
  const { expoPushToken, printerId } = req.body;

  // Try by push token
  if (expoPushToken) {
    const user = await User.findOne({ expo_push_token: expoPushToken }).lean();
    if (user) return user;
  }

  // Fallback: find which MQTT connection owns this printer
  if (printerId) {
    for (const [userId, conn] of mqttService.connections) {
      if (conn.printerIds.has(printerId)) {
        const user = await User.findById(userId).lean();
        if (user) return user;
      }
    }
  }

  // Last resort: just use the first connected user (single-user setup)
  if (mqttService.connections.size > 0) {
    const firstUserId = mqttService.connections.keys().next().value;
    const user = await User.findById(firstUserId).lean();
    if (user) return user;
  }

  res.status(404).json({ ok: false, error: "User not found" });
  return null;
}

// POST /api/printer/pause
router.post("/printer/pause", async (req, res) => {
  try {
    const user = await resolveUser(req, res);
    if (!user) return;
    const { printerId } = req.body;
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const sent = mqttService.pausePrint(String(user._id), printerId);
    log.info(`[CTRL] Pause ${printerId} for user ${user._id}: ${sent ? "sent" : "failed"}`);
    res.json({ ok: sent, error: sent ? null : "MQTT not connected" });
  } catch (err) {
    log.error(`[CTRL] Pause error: ${err.message}`);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// POST /api/printer/resume
router.post("/printer/resume", async (req, res) => {
  try {
    const user = await resolveUser(req, res);
    if (!user) return;
    const { printerId } = req.body;
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const sent = mqttService.resumePrint(String(user._id), printerId);
    log.info(`[CTRL] Resume ${printerId} for user ${user._id}: ${sent ? "sent" : "failed"}`);
    res.json({ ok: sent, error: sent ? null : "MQTT not connected" });
  } catch (err) {
    log.error(`[CTRL] Resume error: ${err.message}`);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// POST /api/printer/stop
router.post("/printer/stop", async (req, res) => {
  try {
    const user = await resolveUser(req, res);
    if (!user) return;
    const { printerId } = req.body;
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const sent = mqttService.stopPrint(String(user._id), printerId);
    log.info(`[CTRL] Stop ${printerId} for user ${user._id}: ${sent ? "sent" : "failed"}`);
    res.json({ ok: sent, error: sent ? null : "MQTT not connected" });
  } catch (err) {
    log.error(`[CTRL] Stop error: ${err.message}`);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// POST /api/printer/speed
router.post("/printer/speed", async (req, res) => {
  try {
    const user = await resolveUser(req, res);
    if (!user) return;
    const { printerId, level } = req.body;
    if (!printerId || !level) return res.status(400).json({ ok: false, error: "Missing printerId or level" });
    if (![1, 2, 3, 4].includes(Number(level))) return res.status(400).json({ ok: false, error: "Level must be 1-4" });

    const sent = mqttService.setSpeed(String(user._id), printerId, Number(level));
    log.info(`[CTRL] Speed ${printerId} → ${level} for user ${user._id}: ${sent ? "sent" : "failed"}`);
    res.json({ ok: sent });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// POST /api/printer/light
router.post("/printer/light", async (req, res) => {
  try {
    const user = await resolveUser(req, res);
    if (!user) return;
    const { printerId, on } = req.body;
    if (!printerId || on === undefined) return res.status(400).json({ ok: false, error: "Missing printerId or on" });

    const sent = mqttService.setLight(String(user._id), printerId, !!on);
    log.info(`[CTRL] Light ${printerId} → ${on ? "on" : "off"} for user ${user._id}: ${sent ? "sent" : "failed"}`);
    res.json({ ok: sent });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// GET /api/printer/mqtt-state — get real-time MQTT state for all printers
// Accepts expoPushToken OR returns all states (printers are filtered client-side by ID)
router.get("/printer/mqtt-state", async (req, res) => {
  try {
    const { expoPushToken } = req.query;

    // Try to find user by push token, otherwise return all MQTT states
    let states = {};
    if (expoPushToken) {
      const user = await User.findOne({ expo_push_token: expoPushToken }).lean();
      if (user) {
        states = mqttService.getAllPrinterStates(String(user._id));
      }
    }

    // If no states found by token, aggregate all connected users' states
    if (Object.keys(states).length === 0) {
      for (const conn of mqttService.connections.values()) {
        for (const [devId, state] of conn.printerStates) {
          states[devId] = state;
        }
      }
    }

    const result = {};
    for (const [devId, state] of Object.entries(states)) {
      result[devId] = {
        gcodeState: state.gcode_state || null,
        percent: state.mc_percent ?? null,
        remainingMin: state.mc_remaining_time ?? null,
        layerNum: state.layer_num ?? null,
        totalLayers: state.total_layer_num ?? null,
        subtaskName: state.subtask_name || null,
        nozzleTemp: state.nozzle_temper ?? null,
        nozzleTarget: state.nozzle_target_temper ?? null,
        bedTemp: state.bed_temper ?? null,
        bedTarget: state.bed_target_temper ?? null,
        chamberTemp: state.chamber_temper ?? null,
        speedLevel: state.spd_lvl ?? null,
        speedMag: state.spd_mag ?? null,
        wifiSignal: state.wifi_signal || null,
        lightOn: state.lights_report?.[0]?.mode === "on" ?? null,
        printType: state.print_type || null,
        taskId: state.task_id || null,
        printError: state.print_error || 0,
        hms: Array.isArray(state.hms) && state.hms.length > 0 ? state.hms : null,
        preparePercent: state.gcode_file_prepare_percent != null ? Number(state.gcode_file_prepare_percent) : null,
        stage: state.stg_cur ?? null,
      };
    }
    res.json({ ok: true, printers: result });
  } catch (err) {
    log.error(`[CTRL] mqtt-state error: ${err.message}`);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

module.exports = router;
