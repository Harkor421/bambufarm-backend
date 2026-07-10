const { Router } = require("express");
const User = require("../db/models/User");

const router = Router();

router.get("/health", async (_req, res) => {
  try {
    const count = await User.countDocuments();
    const mqttService = require("../services/mqttPrinterService");
    const mqttConns = mqttService.connections ? mqttService.connections.size : 0;
    const mqttConnected = mqttService.connections ? [...mqttService.connections.values()].filter(c => c.connected).length : 0;
    res.json({
      ok: true,
      uptime: Math.floor(process.uptime()),
      registeredUsers: count,
      mqtt: { totalConnections: mqttConns, connected: mqttConnected },
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      uptime: Math.floor(process.uptime()),
      error: "Database unavailable",
    });
  }
});

router.get("/mqtt-debug", async (_req, res) => {
  try {
    const mqttService = require("../services/mqttPrinterService");
    const result = [];
    for (const [userId, conn] of mqttService.connections) {
      const printers = {};
      if (conn.printerStates) {
        for (const [devId, state] of conn.printerStates) {
          printers[devId] = { gcode_state: state.gcode_state, mc_percent: state.mc_percent, subtask: state.subtask_name };
        }
      }
      result.push({
        userId,
        bambuUid: conn.bambuUid,
        connected: conn.connected,
        socketAlive: !!(conn.socket && !conn.socket.destroyed),
        clientConnected: !!(conn.client && conn.client.connected),
        printerCount: conn.printerIds?.size || 0,
        printerStates: printers,
      });
    }
    // Optionally spotlight one uid's connections for debugging. Was a hardcoded
    // personal uid shipping in prod code — now driven by the DEBUG_UID env var
    // (unset -> no spotlight), so no personal identifier lives in the source.
    const debugUid = process.env.DEBUG_UID || null;
    const mine = debugUid ? result.filter(r => r.bambuUid === debugUid) : [];
    res.json({ total: result.length, connected: result.filter(r => r.connected).length, myConnections: mine, sample: result.slice(0, 3) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
