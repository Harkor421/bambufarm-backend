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

/**
 * Build the WhatsApp message string for a printer state transition.
 * Returns null when the transition isn't worth broadcasting (no prev state,
 * unrecognized transition, etc). Pure function — no side effects.
 *
 * Critically, returns null when `prevGcodeState` is falsy. On backend boot
 * the very first MQTT push for each printer arrives with prev=undefined; if
 * any printer is currently in FAILED/PAUSE/etc we'd otherwise blast a fake
 * "just happened" alert for an event that may be days old.
 *
 * @param {string} gcState - Current gcode_state
 * @param {string} prevGcodeState - Previous gcode_state (undefined on first message)
 * @param {string} printerName
 * @param {string} jobName
 * @param {number} pct - mc_percent (0-100)
 * @returns {string|null}
 */
function buildBroadcastMessage(gcState, prevGcodeState, printerName, jobName, pct) {
  if (!prevGcodeState) return null;

  if (gcState === "RUNNING" && (prevGcodeState === "IDLE" || prevGcodeState === "FINISH" || prevGcodeState === "FAILED" || prevGcodeState === "PREPARE")) {
    return `🖨 ${printerName} started printing: ${jobName}`;
  }
  if (gcState === "PAUSE" && prevGcodeState === "RUNNING") {
    return `⏸ ${printerName} paused at ${pct}%: ${jobName}`;
  }
  if (gcState === "RUNNING" && prevGcodeState === "PAUSE") {
    return `▶️ ${printerName} resumed at ${pct}%: ${jobName}`;
  }
  if ((gcState === "FINISH" || gcState === "IDLE") && (prevGcodeState === "RUNNING" || prevGcodeState === "PAUSE" || prevGcodeState === "PREPARE")) {
    return pct < 90
      ? `🚫 ${printerName} cancelled at ${pct}%: ${jobName}`
      : `✅ ${printerName} finished: ${jobName}`;
  }
  if (gcState === "FAILED" && (prevGcodeState === "RUNNING" || prevGcodeState === "PAUSE" || prevGcodeState === "PREPARE")) {
    return `⚠️ ${printerName} failed at ${pct}%: ${jobName}`;
  }
  return null;
}

module.exports = { broadcastText, broadcastWithImage, isTecnoprintsAccount, buildBroadcastMessage };
