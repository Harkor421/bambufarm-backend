require("dotenv").config();

const http = require("http");
const app = require("./app");
const { connectDB, mongoose } = require("./db/database");
const { startPolling } = require("./services/poller");
const wsManager = require("./services/wsManager");
const apns = require("./services/apnsSender");
const mqttService = require("./services/mqttPrinterService");
const log = require("./utils/logger");

const PORT = process.env.PORT || 3000;

async function main() {
  // Connect to MongoDB
  await connectDB();

  // Create HTTP server from Express app (needed for WebSocket upgrade)
  const server = http.createServer(app);

  // Attach WebSocket handling
  wsManager.attach(server);

  // Start listening
  server.listen(PORT, () => {
    log.info(`BambuFarm server listening on :${PORT}`);
  });

  // Log APNs configuration status
  apns.logConfig();

  // Lightweight poller — token refresh + printer discovery only (MQTT handles everything else)
  const interval = Number(process.env.POLL_INTERVAL_MS) || 1800000; // 30 min
  startPolling(interval);

  // Start MQTT service for real-time printer state + control
  console.log("[BOOT] Scheduling MQTT service start in 5s...");
  setTimeout(async () => {
    try {
      console.log("[BOOT] Starting MQTT service now...");
      await mqttService.start();
      console.log("[BOOT] MQTT service started successfully");
    } catch (err) {
      console.error("[BOOT] MQTT service CRASHED:", err.stack || err.message || err);
    }
  }, 5000);
}

main().catch((err) => {
  log.error(`[BOOT] Fatal: ${err.message}`);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  log.info("Shutting down...");
  mqttService.stop();
  wsManager.close();
  await mongoose.connection.close();
  process.exit(0);
});
