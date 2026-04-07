/**
 * Pure functions for building notification objects from MQTT state transitions.
 * No side effects, no DB calls, no network — just data transformation.
 */

const { lookupHmsError, formatHmsCode } = require("../utils/hmsErrors");

/**
 * Build a push notification from a state transition.
 * @param {string} gcodeState - Current gcode state (RUNNING, PAUSE, FINISH, etc.)
 * @param {string} effectivePrev - Previous gcode state
 * @param {object} state - Full MQTT state object
 * @param {string} devId - Device ID
 * @param {string} printerName - Human-readable printer name
 * @returns {{ title: string, body: string, data: object } | null}
 */
function buildNotification(gcodeState, effectivePrev, state, devId, printerName) {
  const jobTitle = state.subtask_name || "Print Job";

  if (gcodeState === "PAUSE" && effectivePrev === "RUNNING") {
    const hmsAlerts = Array.isArray(state.hms) ? state.hms : [];
    let pauseBody = "";
    if (hmsAlerts.length > 0) {
      const reasons = hmsAlerts.map((h) => {
        const desc = lookupHmsError(h.attr, h.code);
        return desc || formatHmsCode(h.attr, h.code);
      });
      pauseBody = reasons.join(" | ");
    } else {
      pauseBody = "Paused by user";
    }
    return {
      title: `⏸ ${printerName} paused`,
      body: pauseBody,
      data: { type: "print_paused", printerId: devId, printerName, progressPct: state.mc_percent, remainingSec: (state.mc_remaining_time || 0) * 60 },
    };
  }

  if (gcodeState === "RUNNING" && effectivePrev === "PAUSE") {
    return {
      title: `▶️ ${printerName} resumed`,
      body: jobTitle,
      data: { type: "print_resumed", printerId: devId, printerName, progressPct: state.mc_percent, remainingSec: (state.mc_remaining_time || 0) * 60 },
    };
  }

  if ((gcodeState === "FINISH" || gcodeState === "IDLE") &&
      (effectivePrev === "RUNNING" || effectivePrev === "PAUSE" || effectivePrev === "PREPARE")) {
    const wasCancelled = (state.mc_percent || 0) < 90;
    return {
      title: wasCancelled ? `🚫 ${printerName} cancelled` : `✅ ${printerName} finished`,
      body: jobTitle,
      data: { type: wasCancelled ? "print_error" : "print_finished", printerId: devId, printerName },
    };
  }

  if (gcodeState === "FAILED" &&
      (effectivePrev === "RUNNING" || effectivePrev === "PAUSE" || effectivePrev === "PREPARE")) {
    const hmsAlerts = Array.isArray(state.hms) ? state.hms : [];
    let failBody = state.subtask_name || "Print failed";
    if (hmsAlerts.length > 0) {
      const reasons = hmsAlerts.map((h) => lookupHmsError(h.attr, h.code) || formatHmsCode(h.attr, h.code));
      failBody = reasons.join(" | ");
    }
    return {
      title: `⚠️ ${printerName} failed`,
      body: failBody,
      data: { type: "print_error", printerId: devId, printerName },
    };
  }

  if (gcodeState === "RUNNING" &&
      (effectivePrev === "IDLE" || effectivePrev === "FINISH" || effectivePrev === "FAILED" || effectivePrev === "PREPARE")) {
    return {
      title: `🖨 ${printerName} started printing`,
      body: jobTitle,
      data: { type: "print_started", printerId: devId, printerName, progressPct: state.mc_percent, remainingSec: (state.mc_remaining_time || 0) * 60 },
    };
  }

  return null;
}

/**
 * Normalize progress for LA updates.
 * PREPARE or RUNNING-from-PREPARE with high fake progress → 0.
 */
function normalizeProgress(gcodeState, effectivePrev, rawPercent) {
  const rawProgress = (rawPercent || 0) / 100;
  if (gcodeState === "PREPARE") return 0;
  if (gcodeState === "RUNNING" && effectivePrev === "PREPARE" && rawProgress >= 0.95) return 0;
  return rawProgress;
}

module.exports = { buildNotification, normalizeProgress };
