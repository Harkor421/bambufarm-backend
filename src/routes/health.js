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
  // Filter to show only connections for uid 1789751384
  const mine = result.filter(r => r.bambuUid === "1789751384");
  res.json({ total: result.length, connected: result.filter(r => r.connected).length, myConnections: mine, sample: result.slice(0, 3) });
});

module.exports = router;
