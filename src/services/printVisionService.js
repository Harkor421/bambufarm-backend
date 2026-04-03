/**
 * AI Print Vision Monitor
 *
 * Analyzes camera frames from active prints using Claude Vision API
 * to detect failures (spaghetti, stringing, bed detachment, etc.)
 * and notifies users via push notifications.
 *
 * Currently limited to a single test account (VISION_TARGET_UID).
 */

const Anthropic = require("@anthropic-ai/sdk").default;
const log = require("../utils/logger");
const wsManager = require("./wsManager");
const mqttService = require("./mqttPrinterService");
const { sendPush } = require("./pushSender");
const User = require("../db/models/User");
const PrintAnalysis = require("../db/models/PrintAnalysis");

const VISION_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_INTERVAL = 300000; // 5 minutes
const NOTIFY_COOLDOWN = 900000; // 15 minutes
const REQUIRED_CONSECUTIVE = 2; // consecutive failures before notifying
const MIN_LAYER = 5;
const MIN_PERCENT = 3;

const VISION_PROMPT = `You are a 3D print quality inspector. Analyze this camera frame from a Bambu Lab FDM printer.

Print context:
- Job: {subtask_name}
- Progress: {mc_percent}% (layer {layer_num}/{total_layers})
- Nozzle: {nozzle_temp}°C / Bed: {bed_temp}°C
- State: {gcode_state}

Check for these issues:
1. Spaghetti — filament extruding into air, tangled mess of plastic
2. Bed detachment — print lifting off the build plate, corners curling
3. Warping — visible bending/curling of printed layers
4. Stringing — thin strings of filament between parts or travel moves
5. Layer shifting — visible misalignment/offset between layers
6. Nozzle clog — nozzle moving but no filament extruding
7. Total failure — print completely detached, blob on nozzle

Respond with JSON only (no markdown, no code blocks):
{"verdict":"ok","confidence":85,"issues":[],"detail":"Print looks normal, layers are clean and consistent."}

Rules:
- "ok" = print looks normal for its current stage
- "warning" = minor issue that may self-resolve (e.g. light stringing)
- "failure" = critical issue requiring user attention
- Be conservative — only report "failure" if you are >80% confident
- Early layers will have very little visible print — this is normal, report "ok"
- confidence is 0-100
- issues is an array of strings from the list above (lowercase)`;

class PrintVisionService {
  constructor() {
    this.interval = null;
    this.anthropic = null;
    this.consecutiveFailures = new Map(); // printerId → count
    this.lastNotifiedAt = new Map(); // printerId → timestamp
    this.running = false;
  }

  start() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      log.warn("[VISION] No ANTHROPIC_API_KEY set, vision service disabled");
      return;
    }
    if (process.env.VISION_ENABLED !== "true") {
      log.info("[VISION] Service disabled (VISION_ENABLED != true)");
      return;
    }

    this.anthropic = new Anthropic({ apiKey });
    const intervalMs = Number(process.env.VISION_INTERVAL_MS) || DEFAULT_INTERVAL;
    this.running = true;

    log.info(`[VISION] Starting — interval=${intervalMs / 1000}s target=${process.env.VISION_TARGET_UID || "none"}`);

    // Run first analysis after 30s (let MQTT populate)
    setTimeout(() => {
      if (this.running) this._analyzeAll().catch((e) => log.error(`[VISION] Analysis error: ${e.message}`));
    }, 30000);

    this.interval = setInterval(() => {
      this._analyzeAll().catch((e) => log.error(`[VISION] Analysis error: ${e.message}`));
    }, intervalMs);
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    log.info("[VISION] Stopped");
  }

  async _analyzeAll() {
    const targetUid = process.env.VISION_TARGET_UID;
    if (!targetUid) return;

    // Get all printer states for the target user
    const states = mqttService.getAllPrinterStates(targetUid);
    const count = Object.keys(states).length;
    const running = Object.values(states).filter(s => s.gcode_state === "RUNNING").length;
    log.info(`[VISION] Checking uid=${targetUid}: ${count} printers, ${running} running`);
    if (!states || count === 0) return;

    for (const [devId, state] of Object.entries(states)) {
      if (state.gcode_state !== "RUNNING") continue;

      // Skip early layers
      const layerNum = state.layer_num ?? 0;
      const percent = state.mc_percent ?? 0;
      if (layerNum < MIN_LAYER && percent < MIN_PERCENT) {
        log.debug(`[VISION] Skipping ${devId} — layer ${layerNum}, ${percent}%`);
        continue;
      }

      try {
        await this._analyzePrinter(targetUid, devId, state);
      } catch (e) {
        log.error(`[VISION] Error analyzing ${devId}: ${e.message}`);
      }
    }
  }

  async _analyzePrinter(bambuUid, devId, mqttState) {
    // Get latest camera frame
    const frame = wsManager.getLatestFrame(bambuUid, devId);
    if (!frame || frame.length < 100) {
      log.debug(`[VISION] No frame for ${devId}, skipping`);
      return;
    }

    // Build context
    const context = {
      subtask_name: mqttState.subtask_name || "Unknown",
      mc_percent: mqttState.mc_percent ?? 0,
      layer_num: mqttState.layer_num ?? "?",
      total_layers: mqttState.total_layer_num ?? "?",
      nozzle_temp: Math.round(mqttState.nozzle_temper ?? 0),
      bed_temp: Math.round(mqttState.bed_temper ?? 0),
      gcode_state: mqttState.gcode_state || "RUNNING",
    };

    // Build prompt with context
    let prompt = VISION_PROMPT;
    for (const [key, val] of Object.entries(context)) {
      prompt = prompt.replace(`{${key}}`, String(val));
    }

    // Call Claude Vision
    const result = await this._callVision(frame, prompt);
    if (!result) return;

    // Save to DB
    await PrintAnalysis.create({
      bambu_uid: bambuUid,
      printer_dev_id: devId,
      analyzed_at: new Date(),
      layer_num: mqttState.layer_num ?? null,
      total_layers: mqttState.total_layer_num ?? null,
      mc_percent: mqttState.mc_percent ?? null,
      gcode_state: mqttState.gcode_state,
      subtask_name: mqttState.subtask_name || null,
      verdict: result.verdict,
      confidence: result.confidence || 0,
      issues: result.issues || [],
      detail: result.detail || "",
      notified: false,
      frame_size_bytes: frame.length,
    });

    log.info(`[VISION] ${devId}: ${result.verdict} (${result.confidence}%) ${result.issues?.length ? result.issues.join(", ") : ""}`);

    // Handle failure detection
    await this._handleResult(bambuUid, devId, result, mqttState);
  }

  async _callVision(frameBuffer, prompt) {
    try {
      const base64 = frameBuffer.toString("base64");

      const response = await this.anthropic.messages.create({
        model: VISION_MODEL,
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: base64 },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      });

      const text = response.content?.[0]?.text || "";

      // Parse JSON from response (handle possible markdown wrapping)
      const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      try {
        return JSON.parse(jsonStr);
      } catch {
        log.warn(`[VISION] Failed to parse response: ${text.slice(0, 200)}`);
        return null;
      }
    } catch (e) {
      log.error(`[VISION] API call failed: ${e.message}`);
      return null;
    }
  }

  async _handleResult(bambuUid, devId, result, mqttState) {
    if (result.verdict === "failure" && result.confidence >= 80) {
      const count = (this.consecutiveFailures.get(devId) || 0) + 1;
      this.consecutiveFailures.set(devId, count);

      if (count >= REQUIRED_CONSECUTIVE) {
        const lastNotif = this.lastNotifiedAt.get(devId) || 0;
        if (Date.now() - lastNotif >= NOTIFY_COOLDOWN) {
          await this._notifyUser(bambuUid, devId, result, mqttState);
          this.lastNotifiedAt.set(devId, Date.now());

          // Update DB record
          await PrintAnalysis.updateOne(
            { bambu_uid: bambuUid, printer_dev_id: devId, analyzed_at: { $gte: new Date(Date.now() - 10000) } },
            { notified: true }
          );
        }
      }
    } else {
      // Reset consecutive counter on ok/warning
      this.consecutiveFailures.set(devId, 0);
    }
  }

  async _notifyUser(bambuUid, devId, result, mqttState) {
    try {
      const users = await User.find({ bambu_uid: bambuUid, expo_push_token: { $exists: true, $ne: null } }).lean();
      const printerName = mqttState.subtask_name ? `${devId}` : devId;
      const issueList = result.issues?.join(", ") || "print issue";

      const sentTokens = new Set();
      for (const u of users) {
        if (sentTokens.has(u.expo_push_token)) continue;
        sentTokens.add(u.expo_push_token);
        await sendPush(u.expo_push_token, {
          title: `🚨 Print issue detected`,
          body: `${issueList} — ${result.detail?.slice(0, 100) || "Check your print"}`,
          data: { type: "vision_alert", printerId: devId, verdict: result.verdict, issues: result.issues, bambuUid },
        });
      }

      log.info(`[VISION] Notified ${sentTokens.size} user(s) for ${devId}: ${issueList}`);

      // Send camera frame + alert to Tecnoprints broadcast
      this._broadcastWithImage(bambuUid, devId, result, mqttState).catch(() => {});
    } catch (e) {
      log.error(`[VISION] Notify error: ${e.message}`);
    }
  }

  async _broadcastWithImage(bambuUid, devId, result, mqttState) {
    try {
      const frame = wsManager.getLatestFrame(bambuUid, devId);
      const issueList = result.issues?.join(", ") || "print issue";
      const message = `🚨 ${devId} — ${issueList}: ${result.detail || "Check print"}`;

      const FormData = require("form-data");
      const form = new FormData();
      form.append("message", message);
      if (frame && frame.length > 100) {
        form.append("media", frame, { filename: `${devId}.jpg`, contentType: "image/jpeg" });
      }

      await axios.post(
        "https://backend-production-b1e9.up.railway.app/api/broadcast/tecnoprints",
        form,
        { headers: form.getHeaders(), timeout: 10000 }
      );
      log.info(`[VISION] Tecnoprints broadcast sent for ${devId} (${frame ? frame.length : 0} bytes)`);
    } catch (e) {
      log.warn(`[VISION] Tecnoprints broadcast failed: ${e.message}`);
    }
  }
}

const printVisionService = new PrintVisionService();
module.exports = printVisionService;
