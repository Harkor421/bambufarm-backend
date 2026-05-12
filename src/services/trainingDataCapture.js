/**
 * Training data capture — uploads camera frames + metadata to Cloudflare R2
 * when prints end in interesting states, to build a dataset for our own
 * failure-detection model.
 *
 * Buckets into folders:
 *   - successful_prints/  — print finished cleanly (progress ≥ 90%)
 *   - failed_prints/      — print failed, cancelled, or paused abnormally
 *
 * Each capture uploads two files:
 *   - {prefix}/{timestamp}_{printerId}_{event}.jpg   — the camera frame
 *   - {prefix}/{timestamp}_{printerId}_{event}.json  — metadata (state, HMS, progress, etc.)
 *
 * Only captures frames for users running BambuBridge (i.e., we have a cached
 * JPEG in wsManager.latestFrames for that printer).
 */

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const log = require("../utils/logger");
const config = require("../config");

let s3Client = null;

// Pre-end frame buffer: for successful prints we want the frame from BEFORE the
// build plate lowers, not the one from FINISH time (which shows an empty plate).
// We stash the last frame seen while progress was 95-99% for each active print,
// keyed by `${bambuUid}:${printerId}`.
//
// Lifecycle: entries are written by maybeStashPreEndFrame and read by both
// captureTransition (R2 upload) and the Tecnoprints WhatsApp broadcast. We do
// NOT clear entries after read — the previous code did, which raced with the
// 2-second Tecnoprints sleep and caused the broadcast to fall back to the
// post-plate-lower frame. Entries naturally get overwritten when the next
// print on the same printer reaches the 95-99% window. A periodic sweep below
// caps total entries and drops anything older than ~6 hours.
const preEndFrames = new Map();
const PRE_END_PROGRESS_MIN = 95;
const PRE_END_PROGRESS_MAX = 99;
const PRE_END_MAX_ENTRIES = 500;
const PRE_END_TTL_MS = 6 * 60 * 60 * 1000;

function getClient() {
  if (s3Client) return s3Client;
  const cfg = config.trainingCapture;
  if (!cfg.enabled || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.endpoint) {
    return null;
  }
  s3Client = new S3Client({
    region: "auto",
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
  log.info("[TRAINING] R2 client initialized");
  return s3Client;
}

/**
 * Classify a state transition into a capture event, or null if we don't care.
 *
 * @returns {{ folder: string, event: string } | null}
 */
function classifyEvent(gcodeState, effectivePrev, state) {
  const pct = state?.mc_percent ?? 0;

  // Print succeeded — finished cleanly with high progress
  if (gcodeState === "FINISH" && (effectivePrev === "RUNNING" || effectivePrev === "PAUSE")) {
    if (pct >= 90) return { folder: "successful_prints", event: "finish" };
    return { folder: "failed_prints", event: "cancelled" };
  }

  // Hard failure
  if (gcodeState === "FAILED" && (effectivePrev === "RUNNING" || effectivePrev === "PAUSE" || effectivePrev === "PREPARE")) {
    return { folder: "failed_prints", event: "failed" };
  }

  // Pause from running — most useful signal for training (often indicates a detected problem)
  if (gcodeState === "PAUSE" && effectivePrev === "RUNNING") {
    return { folder: "failed_prints", event: "paused" };
  }

  // IDLE from RUNNING at low progress = user cancelled
  if (gcodeState === "IDLE" && effectivePrev === "RUNNING" && pct < 90) {
    return { folder: "failed_prints", event: "cancelled" };
  }

  return null;
}

/**
 * Stash the latest camera frame if we're in the pre-end window (95-99% progress).
 *
 * Called on every MQTT state update. We keep one frame per printer, overwriting
 * as new frames arrive — so by the time FINISH hits, the buffer holds a frame
 * from shortly before the plate lowered. For successful prints this is the
 * frame we actually want to train on (completed print still on the plate).
 *
 * Best-effort — any error is logged and swallowed.
 */
function maybeStashPreEndFrame(bambuUid, printerId, state) {
  try {
    if (!config.trainingCapture.enabled) return;
    if (!bambuUid || !printerId) return;
    if (state?.gcode_state !== "RUNNING") return;
    const pct = state?.mc_percent;
    if (pct == null || pct < PRE_END_PROGRESS_MIN || pct > PRE_END_PROGRESS_MAX) return;

    const wsManager = require("./wsManager");
    const frame = wsManager.getLatestFrame(bambuUid, printerId);
    if (!frame) return;

    const key = `${bambuUid}:${printerId}`;
    // Delete-then-set refreshes LRU position (Map preserves insertion order)
    preEndFrames.delete(key);
    preEndFrames.set(key, {
      frame,
      capturedAt: Date.now(),
      progressAtCapture: pct,
    });

    // Bound size: evict oldest entries first, then anything past TTL
    while (preEndFrames.size > PRE_END_MAX_ENTRIES) {
      const oldest = preEndFrames.keys().next().value;
      preEndFrames.delete(oldest);
    }
    if (preEndFrames.size > 50) {
      const cutoff = Date.now() - PRE_END_TTL_MS;
      for (const [k, v] of preEndFrames) {
        if (v.capturedAt >= cutoff) break; // entries are insertion-ordered ≈ time-ordered
        preEndFrames.delete(k);
      }
    }
  } catch {}
}

/**
 * Capture a camera frame + metadata for the given state transition, if the user
 * has an active BambuBridge (i.e., a cached frame is available).
 *
 * This is best-effort — any error is logged and swallowed. Never throws.
 */
async function captureTransition({ bambuUid, printerId, printerName, gcodeState, effectivePrev, state, userId }) {
  try {
    if (!config.trainingCapture.enabled) return;

    const event = classifyEvent(gcodeState, effectivePrev, state);
    if (!event) return;
    // NOTE: don't clear the pre-end buffer here — the Tecnoprints WhatsApp
    // broadcast reads it ~2s later. The buffer naturally gets overwritten when
    // the next print on this printer reaches 95-99% progress, and is bounded
    // by the LRU cap in maybeStashPreEndFrame.

    const client = getClient();
    if (!client) return;

    // For successful prints, prefer the pre-end buffered frame (captured before
    // the plate lowered). For failures/cancellations/pauses we want the CURRENT
    // frame because the failure state is what matters.
    const wsManager = require("./wsManager");
    let frame = null;
    let frameSource = "current";
    let frameCapturedAt = null;
    let progressAtCapture = null;

    if (event.event === "finish") {
      const buffered = preEndFrames.get(`${bambuUid}:${printerId}`);
      if (buffered) {
        frame = buffered.frame;
        frameSource = "pre-end-buffer";
        frameCapturedAt = new Date(buffered.capturedAt).toISOString();
        progressAtCapture = buffered.progressAtCapture;
      }
    }
    if (!frame) {
      frame = wsManager.getLatestFrame(bambuUid, printerId);
    }

    if (!frame) {
      // User isn't running BambuBridge or camera isn't streaming — nothing to capture
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = String(printerId).replace(/[^a-zA-Z0-9_-]/g, "");
    const baseKey = `${event.folder}/${timestamp}_${safeName}_${event.event}`;

    const hmsAlerts = Array.isArray(state?.hms) ? state.hms : [];
    const metadata = {
      capturedAt: new Date().toISOString(),
      event: event.event,
      folder: event.folder,
      bambuUid: String(bambuUid),
      userId: userId ? String(userId) : null,
      printerId,
      printerName: printerName || null,
      transition: { from: effectivePrev, to: gcodeState },
      frame: {
        source: frameSource, // "pre-end-buffer" or "current"
        capturedAt: frameCapturedAt, // only set when from pre-end-buffer
        progressAtCapture, // only set when from pre-end-buffer
      },
      progress: {
        mc_percent: state?.mc_percent ?? null,
        mc_remaining_time: state?.mc_remaining_time ?? null,
        layer_num: state?.layer_num ?? null,
        total_layer_num: state?.total_layer_num ?? null,
      },
      subtask_name: state?.subtask_name || null,
      task_id: state?.taskId || state?.task_id || null,
      nozzle_temper: state?.nozzle_temper ?? null,
      bed_temper: state?.bed_temper ?? null,
      hms: hmsAlerts.map((h) => ({ attr: h.attr, code: h.code })),
      // Extra hint fields useful for labeling later
      filament_type: state?.ams?.tray?.[0]?.tray_type || null,
    };

    const bucket = config.trainingCapture.bucket;
    await Promise.all([
      client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `${baseKey}.jpg`,
        Body: frame,
        ContentType: "image/jpeg",
      })),
      client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `${baseKey}.json`,
        Body: JSON.stringify(metadata, null, 2),
        ContentType: "application/json",
      })),
    ]);

    // NOTE: don't clear the pre-end buffer here — Tecnoprints reads it after a
    // 2s sleep. Natural overwrite by the next print's 95-99% window handles
    // staleness, and the LRU cap in maybeStashPreEndFrame bounds memory.

    log.info(`[TRAINING] Captured ${event.folder}/${event.event} for ${printerName || printerId} (${state?.mc_percent || 0}%, frame=${frameSource})`);
  } catch (err) {
    log.warn(`[TRAINING] Capture failed: ${err.message}`);
  }
}

module.exports = {
  captureTransition,
  classifyEvent,
  maybeStashPreEndFrame,
  // Also expose the pre-end frame getter for other services (e.g. WhatsApp)
  getPreEndFrame(bambuUid, printerId) {
    const buffered = preEndFrames.get(`${bambuUid}:${printerId}`);
    return buffered ? buffered.frame : null;
  },
};
