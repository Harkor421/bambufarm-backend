/**
 * Tecnoprints WhatsApp broadcast service.
 * Sends text and/or image messages to the Tecnoprints broadcast endpoint.
 * Built-in deduplication to prevent duplicate messages within a short window.
 */

const axios = require("axios");
const FormData = require("form-data");
const config = require("../config");
const log = require("../utils/logger");

let _lastBroadcast = { message: "", at: 0 };

/**
 * Send a text-only broadcast. Deduplicates within 30s window.
 * @param {string} message
 */
async function broadcastText(message) {
  if (!message) return;
  // Deduplicate
  if (message === _lastBroadcast.message && Date.now() - _lastBroadcast.at < config.tecnoprints.dedupWindow) return;
  _lastBroadcast = { message, at: Date.now() };

  try {
    await axios.post(config.tecnoprints.broadcastUrl, { message }, {
      timeout: 5000,
      headers: { "Content-Type": "application/json" },
    });
    log.debug(`[TECNOPRINTS] Sent: "${message.slice(0, 80)}"`);
  } catch (e) {
    log.warn(`[TECNOPRINTS] Text broadcast failed: ${e.message}`);
  }
}

/**
 * Send a broadcast with an optional camera frame image.
 * @param {string} message
 * @param {Buffer|null} frameBuffer - JPEG buffer or null
 */
async function broadcastWithImage(message, frameBuffer) {
  if (!message) return;

  try {
    const form = new FormData();
    form.append("message", message);
    if (frameBuffer && frameBuffer.length > 100) {
      form.append("media", frameBuffer, { filename: "frame.jpg", contentType: "image/jpeg" });
    }
    await axios.post(config.tecnoprints.broadcastUrl, form, {
      headers: form.getHeaders(),
      timeout: 10000,
    });
    log.info(`[TECNOPRINTS] Sent with image: "${message.slice(0, 60)}" (${frameBuffer ? frameBuffer.length : 0} bytes)`);
  } catch (e) {
    log.warn(`[TECNOPRINTS] Image broadcast failed: ${e.message}`);
  }
}

/**
 * Check if a bambu_uid matches the Tecnoprints account.
 * @param {string} bambuUid
 * @returns {boolean}
 */
function isTecnoprintsAccount(bambuUid) {
  return bambuUid === config.tecnoprints.bambuUid;
}

module.exports = { broadcastText, broadcastWithImage, isTecnoprintsAccount };
