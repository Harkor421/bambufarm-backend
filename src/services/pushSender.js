const axios = require("axios");
const log = require("../utils/logger");
const { broadcastText, isTecnoprintsAccount } = require("./tecnoprintsBroadcast");

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

    // Also broadcast to Tecnoprints WhatsApp for matching account
    if (data?.bambuUid && isTecnoprintsAccount(data.bambuUid)) {
      const msg = title && body ? `${title}: ${body}` : title || body || "";
      broadcastText(msg).catch(() => {});
    }

    return r.data;
  } catch (err) {
    log.error(`[PUSH] Failed: ${err.message}`);
    return null;
  }
}

module.exports = { sendPush };
