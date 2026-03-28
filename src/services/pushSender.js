const axios = require("axios");
const log = require("../utils/logger");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

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
    ...(data ? { data } : {}),
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
    return r.data;
  } catch (err) {
    log.error(`[PUSH] Failed: ${err.message}`);
    return null;
  }
}

module.exports = { sendPush };
