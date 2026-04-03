const axios = require("axios");
const log = require("../utils/logger");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const TECNOPRINTS_BROADCAST_URL = "https://backend-production-b1e9.up.railway.app/api/broadcast/tecnoprints";
const TECNOPRINTS_BAMBU_UID = "1789751384";
let _lastBroadcast = { message: "", at: 0 }; // dedup: same message within 30s

/**
 * Send a push notification via Expo's push service.
 * Returns the Expo response data, or null on failure.
 */
async function sendPush(expoPushToken, { title, body, data }) {
  const message = {
    to: expoPushToken,
    sound: "default",
    title,
    body,
    channelId: "prints",
    mutableContent: true,
    _contentAvailable: true,
    priority: "high",
    ...(data ? { data: { ...data, expoPushToken } } : {}),
  };

  try {
    const r = await axios.post(EXPO_PUSH_URL, message, {
      timeout: 10000,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    const ticket = r.data?.data;
    if (ticket?.status === "error" && ticket?.details?.error === "DeviceNotRegistered") {
      log.warn(`[PUSH] DeviceNotRegistered: ${expoPushToken.slice(0, 30)}...`);
      return { deviceNotRegistered: true };
    }

    log.info(`[PUSH] Sent to ${expoPushToken.slice(0, 30)}...: "${title}"`);

    // Also broadcast to Tecnoprints endpoint for aerustudiohelp account
    if (data?.bambuUid === TECNOPRINTS_BAMBU_UID) {
      _broadcastTecnoprints(title, body).catch(() => {});
    }

    return r.data;
  } catch (err) {
    log.error(`[PUSH] Failed: ${err.message}`);
    return null;
  }
}

/**
 * Forward notification to Tecnoprints broadcast endpoint.
 */
async function _broadcastTecnoprints(title, body) {
  try {
    const message = title && body ? `${title}: ${body}` : title || body || "";
    if (!message) return;
    // Deduplicate: skip if same message was sent in the last 30s
    if (message === _lastBroadcast.message && Date.now() - _lastBroadcast.at < 30000) return;
    _lastBroadcast = { message, at: Date.now() };
    await axios.post(TECNOPRINTS_BROADCAST_URL, { message }, {
      timeout: 5000,
      headers: { "Content-Type": "application/json" },
    });
    log.debug(`[PUSH] Tecnoprints broadcast: "${message.slice(0, 80)}"`);
  } catch {}
}

module.exports = { sendPush };
