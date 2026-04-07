/**
 * Centralized configuration for the BambuFarm server.
 * All environment variables and constants in one place.
 */

module.exports = {
  port: Number(process.env.PORT) || 3000,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/bambufarm",
  apiKey: process.env.API_KEY,
  adminPassword: process.env.ADMIN_PASSWORD,
  logLevel: process.env.LOG_LEVEL || "info",

  bambu: {
    apiBase: "https://api.bambulab.com",
    mqttHost: "us.mqtt.bambulab.com",
    mqttPort: 8883,
    pushallInterval: 60000,
    reconnectDelay: 10000,
  },

  mqtt: {
    pollInterval: Number(process.env.POLL_INTERVAL_MS) || 1800000, // 30 min
    staggerPauseEvery: 10, // pause every N users during connect
    staggerPauseMs: 2000, // ms to pause
    rateLimitBackoff: 10000, // ms to wait on 429
    progressThrottle: 150000, // min ms between LA progress updates
  },

  apns: {
    keyPath: process.env.APNS_KEY_PATH,
    keyId: process.env.APNS_KEY_ID,
    teamId: process.env.APNS_TEAM_ID,
    keyContents: process.env.APNS_KEY_CONTENTS,
    host: process.env.APNS_HOST || "api.push.apple.com",
    hostSandbox: "api.sandbox.push.apple.com",
    bundleId: "com.harkor421.bambufarm",
  },

  vision: {
    enabled: process.env.VISION_ENABLED === "true",
    targetUid: process.env.VISION_TARGET_UID,
    intervalMs: Number(process.env.VISION_INTERVAL_MS) || 60000,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    model: "claude-haiku-4-5-20251001",
    percentStep: 5,
    minAnalysisGap: 180000, // 3 min
    maxAnalysisGap: 600000, // 10 min
    minLayer: 5,
    minPercent: 3,
    confidenceThreshold: 40,
    consecutiveFailures: 2,
    notifyCooldown: 900000, // 15 min
  },

  tecnoprints: {
    bambuUid: process.env.TECNOPRINTS_UID || "1789751384",
    broadcastUrl: process.env.TECNOPRINTS_URL || "https://backend-production-b1e9.up.railway.app/api/broadcast/tecnoprints",
    dedupWindow: 30000, // 30s
  },

  publicCameraUid: process.env.PUBLIC_CAMERA_UID,

  ws: {
    heartbeatInterval: 30000,
    frameThrottle: 2000, // min ms between frame relays
    commandTimeout: 10000,
    authTimeout: 15000,
  },
};
