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
      log.warn(`[PUSH] DeviceNotRegistered: ${expoPushToken.slice(0, 30)}... — purging user`);
      // User uninstalled the app — clean up their record so we stop trying to
      // notify them (and stop wasting Bambu API calls polling their account).
      try {
        const { deleteUserAndRelated } = require("./userGc");
        deleteUserAndRelated({ expo_push_token: expoPushToken }, "expo:DeviceNotRegistered").catch(() => {});
      } catch {}
      return { deviceNotRegistered: true };
    }

    log.info(`[PUSH] Sent to ${expoPushToken.slice(0, 30)}...: "${title}"`);

    // NOTE: Tecnoprints WhatsApp broadcast is handled in mqttPrinterService's
    // onStateChange (with the camera frame attached). Don't fire a text-only
    // broadcast here — it caused every state change to send TWO WhatsApp
    // messages: the text version from this path + the with-image version
    // from mqttPrinterService.

    return r.data;
  } catch (err) {
    log.error(`[PUSH] Failed: ${err.message}`);
    return null;
  }
}

module.exports = { sendPush };
