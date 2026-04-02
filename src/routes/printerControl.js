const { Router } = require("express");
const mqttService = require("../services/mqttPrinterService");
const wsManager = require("../services/wsManager");
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

/**
 * Generic command handler: tries bridge relay first, falls back to direct cloud MQTT.
 * Bridge relay works for ALL commands (no signing needed on LAN).
 * Cloud MQTT only works for light control (signing required for other commands).
 */
async function handleCommand(req, res, action, paramsFn) {
  try {
    const user = await resolveUser(req, res);
    if (!user) return;
    const { printerId } = req.body;
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const params = paramsFn ? paramsFn(req.body) : {};

    // Try bridge relay first (works for all commands, no signing needed)
    if (user.bambu_uid && wsManager.isBridgeConnected(user.bambu_uid)) {
      const result = await wsManager.sendPrinterCommand(user.bambu_uid, printerId, action, params);
      log.info(`[CTRL] ${action} ${printerId} via bridge: ${result.success ? "ok" : result.error}`);
      return res.json({ ok: result.success, via: "bridge", error: result.error || null });
    }

    // Fallback: direct cloud MQTT (only works for light control on newer firmware)
    let sent = false;
    const userId = String(user._id);
    switch (action) {
      case "pause": sent = mqttService.pausePrint(userId, printerId); break;
      case "resume": sent = mqttService.resumePrint(userId, printerId); break;
      case "stop": sent = mqttService.stopPrint(userId, printerId); break;
      case "speed": sent = mqttService.setSpeed(userId, printerId, params.level); break;
      case "light": sent = mqttService.setLight(userId, printerId, params.on); break;
      default: return res.status(400).json({ ok: false, error: "Unknown action" });
    }
    log.info(`[CTRL] ${action} ${printerId} via MQTT: ${sent ? "sent" : "failed"}`);
    res.json({ ok: sent, via: "mqtt", error: sent ? null : "MQTT not connected" });
  } catch (err) {
    log.error(`[CTRL] ${action} error: ${err.message}`);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
}

// POST /api/printer/pause
router.post("/printer/pause", (req, res) => handleCommand(req, res, "pause"));

// POST /api/printer/resume
router.post("/printer/resume", (req, res) => handleCommand(req, res, "resume"));

// POST /api/printer/stop
router.post("/printer/stop", (req, res) => handleCommand(req, res, "stop"));

// POST /api/printer/speed
router.post("/printer/speed", (req, res) => {
  const { level } = req.body;
  if (!level || ![1, 2, 3, 4].includes(Number(level))) {
    return res.status(400).json({ ok: false, error: "Level must be 1-4" });
  }
  handleCommand(req, res, "speed", () => ({ level: Number(level) }));
});

// POST /api/printer/light
router.post("/printer/light", (req, res) => {
  const { on } = req.body;
  if (on === undefined) return res.status(400).json({ ok: false, error: "Missing on" });
  handleCommand(req, res, "light", () => ({ on: !!on }));
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
