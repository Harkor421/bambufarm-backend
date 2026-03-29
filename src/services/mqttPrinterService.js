// MQTT Printer Service

/**
 * Bambu Cloud MQTT Service
 *
 * Connects to the Bambu Lab Cloud MQTT broker to get real-time printer state.
 * This is the same protocol Bambu Handy uses — gives us gcode_state (RUNNING/PAUSE/IDLE/FINISH),
 * actual progress, temperatures, AMS data, and the ability to send commands (pause/resume/stop).
 *
 * Replaces the unreliable REST-based polling for print state detection.
 */

const mqttLib = require("mqtt");
const axios = require("axios");
const log = require("../utils/logger");
const User = require("../db/models/User");
const PrinterState = require("../db/models/PrinterState");
const { sendPush } = require("./pushSender");
const apns = require("./apnsSender");
const { getActivityToken, clearActivityToken, clearPushToStartToken, isTokenInvalid } = require("./apnsTokenUtils");
const { ensureFreshToken } = require("./tokenRefresh");
const { lookupHmsError, formatHmsCode } = require("../utils/hmsErrors");

const BAMBU_API = "https://api.bambulab.com";
const MQTT_HOST = "us.mqtt.bambulab.com";
const MQTT_PORT = 8883;
const PUSHALL_INTERVAL = 60000;
const RECONNECT_DELAY = 10000;

// ── Per-user MQTT connection ───────────────────────────

class PrinterMqttConnection {
  constructor({ userId, bambuUid, accessToken, printerIds, onStateChange, onProgressUpdate }) {
    this.userId = userId;
    this.bambuUid = bambuUid;
    this.accessToken = accessToken;
    this.printerIds = printerIds; // Set of dev_ids
    this.onStateChange = onStateChange;
    this.onProgressUpdate = onProgressUpdate;
    this.socket = null;
    this.connected = false;
    this.buf = Buffer.alloc(0);
    this.pushallTimer = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.stopped = false;
    this.printerStates = new Map(); // devId → { gcode_state, mc_percent, mc_remaining_time, ... }
    this.sequenceId = 0;
  }

  connect() {
    if (this.stopped) return;
    log.info(`[MQTT] Connecting user ${this.userId} (uid=${this.bambuUid})...`);

    try {
      const clientId = `bambufarm_${this.userId}_${Date.now()}`;
      this.client = mqttLib.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
        username: `u_${this.bambuUid}`,
        password: this.accessToken,
        clientId,
        rejectUnauthorized: false,
        reconnectPeriod: RECONNECT_DELAY,
        keepalive: 30,
      });

      this.client.on("connect", () => {
        this.connected = true;
        this.socket = this.client.stream; // for dead-connection check
        log.info(`[MQTT] Connected for user ${this.userId} (${this.printerIds.size} printers)`);
        this._subscribeAll();
        // Request full state for all printers
        setTimeout(() => this._pushallAll(), 1000);
        // Periodic pushall
        this.pushallTimer = setInterval(() => this._pushallAll(), PUSHALL_INTERVAL);
      });

      this.client.on("message", (topic, payload) => {
        this._handlePublish(topic, payload);
      });

      this.client.on("error", (err) => {
        log.error(`[MQTT] Error for user ${this.userId}: ${err.message}`);
      });

      this.client.on("close", () => {
        this.connected = false;
        this._stopTimers();
        if (!this.stopped) {
          log.info(`[MQTT] Disconnected for user ${this.userId}, will auto-reconnect`);
        }
      });
    } catch (err) {
      log.error(`[MQTT] Connect failed for user ${this.userId}: ${err.message}`);
    }
  }

  stop() {
    this.stopped = true;
    this._stopTimers();
    if (this.client) {
      try { this.client.end(true); } catch {}
      this.client = null;
      this.socket = null;
    }
  }

  /** Send a command to a specific printer */
  sendCommand(devId, command) {
    if (!this.connected || !this.client) return false;
    const topic = `device/${devId}/request`;
    this.sequenceId++;
    try {
      this.client.publish(topic, JSON.stringify(command));
      return true;
    } catch {
      return false;
    }
  }

  /** Send pause command */
  pausePrint(devId) {
    return this.sendCommand(devId, { print: { sequence_id: String(this.sequenceId), command: "pause" } });
  }

  /** Send resume command */
  resumePrint(devId) {
    return this.sendCommand(devId, { print: { sequence_id: String(this.sequenceId), command: "resume" } });
  }

  /** Send stop command */
  stopPrint(devId) {
    return this.sendCommand(devId, { print: { sequence_id: String(this.sequenceId), command: "stop" } });
  }

  /** Set print speed level (1=Silent, 2=Standard, 3=Sport, 4=Ludicrous) */
  setSpeed(devId, level) {
    return this.sendCommand(devId, { print: { sequence_id: String(this.sequenceId), command: "print_speed", param: String(level) } });
  }

  /** Toggle chamber light */
  setLight(devId, on) {
    return this.sendCommand(devId, {
      system: { sequence_id: String(this.sequenceId), command: "ledctrl", led_node: "chamber_light", led_mode: on ? "on" : "off", led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 },
    });
  }

  /** Send raw gcode */
  sendGcode(devId, gcode) {
    return this.sendCommand(devId, { print: { sequence_id: String(this.sequenceId), command: "gcode_line", param: gcode + "\n" } });
  }

  // ── Internal ─────────────────────────────────


  async _handlePublish(topic, payload) {
    // topic = device/{devId}/report
    const match = topic.match(/^device\/([^/]+)\/report$/);
    if (!match) return;
    const devId = match[1];
    if (!this.printerIds.has(devId)) return;

    let json;
    try { json = JSON.parse(payload.toString()); } catch { return; }
    if (!json.print) return;

    // Debug: log gcode_state changes for troubleshooting
    if (json.print.gcode_state) {
      const prevState = this.printerStates.get(devId)?.gcode_state;
      if (prevState !== json.print.gcode_state) {
        // debug log removed for production
      }
    }

    const p = json.print;
    const prev = this.printerStates.get(devId) || {};

    // Merge incremental update into stored state
    const merged = { ...prev };
    for (const key of Object.keys(p)) {
      if (p[key] !== undefined && p[key] !== null) merged[key] = p[key];
    }
    this.printerStates.set(devId, merged);

    // Detect gcode_state changes
    if (p.gcode_state && p.gcode_state !== prev.gcode_state) {
      log.info(`[MQTT] ${devId}: ${prev.gcode_state || "?"} → ${p.gcode_state} (${merged.mc_percent}%, ${merged.mc_remaining_time}min remaining)`);
      try {
        await this.onStateChange(devId, merged, prev.gcode_state);
      } catch (err) {
        log.error(`[MQTT] onStateChange error for ${devId}: ${err.message}\n${err.stack}`);
      }
    }

    // Send LA progress update — throttled to once per 60s per printer to stay within Apple's budget
    const pctChanged = p.mc_percent != null && p.mc_percent !== (prev.mc_percent ?? -1);
    if (merged.gcode_state === "RUNNING" && pctChanged && merged.mc_percent != null) {
      const now = Date.now();
      const lastUpdate = this._lastProgressUpdate?.get(devId) || 0;
      if (now - lastUpdate >= 150000) {
        if (!this._lastProgressUpdate) this._lastProgressUpdate = new Map();
        this._lastProgressUpdate.set(devId, now);
        try {
          if (this.onProgressUpdate) await this.onProgressUpdate(devId, merged);
        } catch (err) { log.error(`[MQTT] onProgressUpdate error for ${devId}: ${err.message}`); }
      }
    }
  }

  _subscribeAll() {
    if (!this.client) return;
    for (const devId of this.printerIds) {
      this.client.subscribe(`device/${devId}/report`);
    }
  }

  _pushallAll() {
    if (!this.client) return;
    for (const devId of this.printerIds) {
      this.sequenceId++;
      this.client.publish(`device/${devId}/request`, JSON.stringify({
        pushing: { sequence_id: String(this.sequenceId), command: "pushall", version: 1, push_target: 1 },
      }));
    }
  }

  // Kept for compatibility — alias
  _pushAll() { this._pushallAll(); }

  _startTimers() {
    // mqtt library handles keepalive/ping automatically
  }

  _stopTimers() {
    if (this.pushallTimer) clearInterval(this.pushallTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pushallTimer = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
  }
}

// ── Service manager ────────────────────────────────────

class MqttPrinterService {
  constructor() {
    /** @type {Map<string, PrinterMqttConnection>} userId → connection */
    this.connections = new Map();
    this.pollTimer = null;
  }

  /**
   * Start the MQTT service. Connects to the broker for each registered user.
   */
  async start() {
    log.info("[MQTT] Starting MQTT printer service...");
    await this._connectAllUsers();
    // Re-check for new users every 60s
    this.pollTimer = setInterval(() => this._connectAllUsers(), 60000);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const conn of this.connections.values()) {
      conn.stop();
    }
    this.connections.clear();
    log.info("[MQTT] Service stopped");
  }

  /** Get the current MQTT state for a printer */
  getPrinterState(userId, devId) {
    const conn = this._findConnectionByUserId(userId);
    return conn?.printerStates.get(devId) || null;
  }

  /** Get all printer states for a user */
  getAllPrinterStates(userId) {
    const conn = this._findConnectionByUserId(userId);
    if (!conn) return {};
    const result = {};
    for (const [devId, state] of conn.printerStates) {
      result[devId] = state;
    }
    return result;
  }

  /** Send a command to a printer */
  sendCommand(userId, devId, command) {
    const conn = this._findConnectionByUserId(userId);
    if (!conn) return false;
    return conn.sendCommand(devId, command);
  }

  pausePrint(userId, devId) {
    const conn = this._findConnectionByUserId(userId);
    return conn ? conn.pausePrint(devId) : false;
  }

  resumePrint(userId, devId) {
    const conn = this._findConnectionByUserId(userId);
    return conn ? conn.resumePrint(devId) : false;
  }

  stopPrint(userId, devId) {
    const conn = this._findConnectionByUserId(userId);
    return conn ? conn.stopPrint(devId) : false;
  }

  setSpeed(userId, devId, level) {
    const conn = this._findConnectionByUserId(userId);
    return conn ? conn.setSpeed(devId, level) : false;
  }

  setLight(userId, devId, on) {
    const conn = this._findConnectionByUserId(userId);
    return conn ? conn.setLight(devId, on) : false;
  }

  sendGcode(userId, devId, gcode) {
    const conn = this._findConnectionByUserId(userId);
    return conn ? conn.sendGcode(devId, gcode) : false;
  }

  // ── Internal ─────────────────────────────────

  _findConnectionByUserId(userId) {
    // userId could be MongoDB _id string or Bambu uid
    for (const [key, conn] of this.connections) {
      if (key === String(userId) || conn.bambuUid === String(userId)) return conn;
    }
    return null;
  }

  async _connectAllUsers() {
    try {
      log.debug("[MQTT] Connecting all users...");
      const users = await User.find({ fail_count: { $lt: 5 } }).lean();
      log.debug(`[MQTT] ${users.length} users`);

      // Track connected Bambu UIDs to avoid duplicate MQTT connections.
      // Multiple DB user records can share the same Bambu account (e.g. dev + prod builds).
      // MQTT broker disconnects the first client when a second connects with the same username.
      const connectedBambuUids = new Map(); // bambuUid → userId

      // Collect already-connected UIDs
      for (const [userId, conn] of this.connections) {
        if (conn.bambuUid) connectedBambuUids.set(conn.bambuUid, userId);
      }

      for (const user of users) {
        const id = String(user._id);
        if (this.connections.has(id)) {
          const existing = this.connections.get(id);
          if (existing.connected && existing.socket && !existing.socket.destroyed) {
            // already connected, skip
            continue;
          }
          // Connection is dead — clean up and reconnect
          log.info(`[MQTT] User ${id} connection is dead, reconnecting...`);
          existing.stop();
          this.connections.delete(id);
        }

        try {
          // Ensure fresh token
          // refresh token
          const accessToken = await ensureFreshToken(user);
          // token OK, fetch profile

          // Get Bambu UID
          const profile = await axios.get(`${BAMBU_API}/v1/user-service/my/profile`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 10000,
          });
          const bambuUid = String(profile.data.uid);
          log.debug(`[MQTT] User ${id} uid=${bambuUid}`);

          // Skip if another user record with the same Bambu UID is already connected
          if (connectedBambuUids.has(bambuUid)) {
            log.debug(`[MQTT] User ${id} uid=${bambuUid} already connected via user ${connectedBambuUids.get(bambuUid)}, skipping duplicate`);
            continue;
          }
          connectedBambuUids.set(bambuUid, id);

          // Get printer list
          const printers = await axios.get(`${BAMBU_API}/v1/iot-service/api/user/bind`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 10000,
          });
          const devices = printers.data?.devices || [];
          const printerIds = new Set(devices.map(d => d.dev_id));
          const printerNames = {};
          for (const d of devices) printerNames[d.dev_id] = d.name;

          if (printerIds.size === 0) {
            log.info(`[MQTT] No online printers for user ${id}, skipping`);
            continue;
          }

          // Store bambu_uid and reset fail_count on successful connection
          await User.updateMany(
            { bambu_access_token: accessToken },
            { bambu_uid: bambuUid, fail_count: 0 }
          );

          const conn = new PrinterMqttConnection({
            userId: id,
            bambuUid,
            accessToken,
            printerIds,
            onStateChange: async (devId, state, prevGcodeState) => {
              // Send to ALL user records with the same Bambu UID
              const allSameAccount = await User.find({
                bambu_uid: bambuUid,
                expo_push_token: { $exists: true, $ne: null },
                fail_count: { $lt: 5 },
              }).lean();
              log.debug(`[MQTT] Notifying ${allSameAccount.length} user(s) for uid ${bambuUid}`);
              // Track which push-to-start tokens we've already sent to avoid duplicates
              const sentPushToStartTokens = new Set();
              for (const u of allSameAccount) {
                const skipPushToStart = u.la_push_to_start_token && sentPushToStartTokens.has(u.la_push_to_start_token);
                if (u.la_push_to_start_token) sentPushToStartTokens.add(u.la_push_to_start_token);
                await this._handleStateChange(u, devId, state, prevGcodeState, skipPushToStart, printerNames);
              }
            },
            onProgressUpdate: async (devId, state) => {
              // Update LA via activity update token (push-to-start only works for "start" event)
              const allUsers = await User.find({ bambu_uid: bambuUid, fail_count: { $lt: 5 } }).lean();
              const nowSec = Math.floor(Date.now() / 1000);
              const progress = (state.mc_percent || 0) / 100;
              const remaining = (state.mc_remaining_time || 0) * 60;
              const pName = printerNames[devId] || devId;
              const jTitle = state.subtask_name || "Print Job";

              const contentState = {
                jobTitle: jTitle, progress,
                startTime: nowSec,
                endTime: remaining > 0 ? nowSec + remaining : nowSec,
                status: "printing",
              };

              const sentTokens = new Set();
              const sentPushTokens = new Set();
              for (const u of allUsers) {
                const actToken = getActivityToken(u, devId);
                if (!actToken || sentTokens.has(actToken)) continue;
                sentTokens.add(actToken);
                try {
                  const r = await apns.sendLiveActivityUpdate(actToken, contentState, 10);
                  if (r?.success) {
                    log.info(`[APNS] Progress ${pName}: ${Math.round(progress * 100)}%`);
                  } else {
                    log.warn(`[APNS] Progress failed ${pName} (${r?.status}): ${r?.reason?.reason}`);
                  }
                  if (isTokenInvalid(r)) await clearActivityToken(u._id, devId);
                } catch (e) {
                  log.warn(`[APNS] Progress error ${pName}: ${e.message}`);
                }

                // Send silent push to trigger NSE → refresh LA thumbnail image
                if (u.expo_push_token && !sentPushTokens.has(u.expo_push_token)) {
                  sentPushTokens.add(u.expo_push_token);
                  sendPush(u.expo_push_token, {
                    title: null, body: null,
                    data: { type: "la_image_refresh", printerId: devId, printerName: pName, bambuUid: bambuUid || "" },
                  }).catch(() => {});
                }
              }
            },
          });

          this.connections.set(id, conn);
          conn.connect();
        } catch (err) {
          log.error(`[MQTT] Failed to set up user ${id}: ${err.message}`);
        }
      }
    } catch (err) {
      log.error(`[MQTT] Error connecting users: ${err.message}`);
    }
  }

  async _handleStateChange(user, devId, state, prevGcodeState, skipPushToStart = false, printerNames = {}) {
    const userId = user._id;
    const gcodeState = state.gcode_state;
    const printerName = printerNames[devId] || devId;
    const jobTitle = state.subtask_name || "Print Job";

    // Map gcode_state to our status
    const statusMap = { RUNNING: "printing", PAUSE: "paused", IDLE: "idle", FINISH: "idle", FAILED: "idle", PREPARE: "printing" };
    const newStatus = statusMap[gcodeState] || "idle";
    const prevStatus = statusMap[prevGcodeState] || "unknown";

    // Update PrinterState in DB
    const update = {
      notif_status: newStatus,
      last_status: newStatus,
      notif_last_message_id: `mqtt_${Date.now()}`,
    };

    if (newStatus === "printing") {
      update.notif_paused_at = null;
      update.notif_frozen_remaining_sec = null;
      update.notif_frozen_progress_pct = null;
      if (state.mc_remaining_time) update.notif_cost_time_sec = state.mc_remaining_time * 60;
      update.notif_started_at = new Date();
      if (state.subtask_name) update.notif_job_title = state.subtask_name;
    } else if (newStatus === "paused") {
      update.notif_paused_at = new Date();
      update.notif_frozen_remaining_sec = state.mc_remaining_time ? state.mc_remaining_time * 60 : null;
      update.notif_frozen_progress_pct = state.mc_percent || null;
    } else if (newStatus === "idle") {
      update.notif_paused_at = null;
      update.notif_frozen_remaining_sec = null;
      update.notif_frozen_progress_pct = null;
    }

    // NOTE: mqtt_last_notif_at is set AFTER successful APNs delivery below,
    // not here, so the poller can retry if MQTT's APNs push fails.

    await PrinterState.findOneAndUpdate(
      { user_id: userId, printer_dev_id: devId },
      update,
      { upsert: true }
    );

    // Send push notifications for state transitions
    log.info(`[MQTT] State change ${devId}: ${prevGcodeState} → ${gcodeState} (user ${userId})`);

    // On first connect (prevGcodeState is undefined/"?"), check DB to see if this is truly new
    let effectivePrev = prevGcodeState;
    if (!prevGcodeState || prevGcodeState === "?") {
      // Look up what the DB thinks the printer was doing before this connect
      const dbState = await PrinterState.findOne({ user_id: userId, printer_dev_id: devId }).lean();
      const dbStatus = dbState?.notif_status || dbState?.last_status || "idle";
      // Map DB status back to gcode_state equivalent
      const dbToGcode = { printing: "RUNNING", paused: "PAUSE", idle: "IDLE", offline: "IDLE" };
      effectivePrev = dbToGcode[dbStatus] || "IDLE";
      if (effectivePrev === gcodeState) {
        if (gcodeState === "RUNNING") {
          // DB says printing, MQTT says RUNNING — printer was already running before deploy.
          // Send LA UPDATE to fix stale "preparing" state. Check ALL users for activity token.
          log.debug(`[MQTT] First connect ${devId}: already RUNNING, sending LA update to all users`);
          if (apns.isConfigured()) {
            const nowSec = Math.floor(Date.now() / 1000);
            const mcProgress = (state.mc_percent || 0) / 100;
            const mcRemaining = (state.mc_remaining_time || 0) * 60;
            const contentState = {
              jobTitle: jobTitle,
              progress: mcProgress,
              startTime: nowSec,
              endTime: mcRemaining > 0 ? nowSec + mcRemaining : nowSec + 3600,
              status: "printing",
            };
            // Use activity update token from ANY user record with same bambu_uid
            const allUsers = await User.find({ bambu_uid: user.bambu_uid || "none", fail_count: { $lt: 5 } }).lean();
            for (const u of allUsers) {
              const actToken = getActivityToken(u, devId);
              if (!actToken) continue;
              const r = await apns.sendLiveActivityUpdate(actToken, contentState);
              if (r?.success) {
                log.info(`[MQTT] LA update sent for ${devId}`);
                break;
              }
              if (isTokenInvalid(r)) await clearActivityToken(u._id, devId);
            }
          }
          return;
        }
        log.debug(`[MQTT] First connect ${devId}: DB already ${dbStatus}, skipping`);
        return;
      }
      log.debug(`[MQTT] First connect ${devId}: DB was ${dbStatus} (${effectivePrev}), MQTT is ${gcodeState} — treating as transition`);
    }

    if (effectivePrev && gcodeState !== effectivePrev) {
      let notification = null;

      if (gcodeState === "PAUSE" && effectivePrev === "RUNNING") {
        // Build pause reason from HMS alerts
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

        notification = {
          title: `⏸ ${printerName} paused`,
          body: pauseBody,
          data: { type: "print_paused", printerId: devId, printerName, progressPct: state.mc_percent, remainingSec: (state.mc_remaining_time || 0) * 60 },
        };
      } else if (gcodeState === "RUNNING" && effectivePrev === "PAUSE") {
        notification = {
          title: `▶️ ${printerName} resumed`,
          body: jobTitle,
          data: { type: "print_resumed", printerId: devId, printerName, progressPct: state.mc_percent, remainingSec: (state.mc_remaining_time || 0) * 60 },
        };
      } else if ((gcodeState === "FINISH" || gcodeState === "IDLE") && (effectivePrev === "RUNNING" || effectivePrev === "PAUSE" || effectivePrev === "PREPARE")) {
        // Distinguish finished vs cancelled: if progress < 90%, it was likely cancelled
        const wasCancelled = (state.mc_percent || 0) < 90;
        notification = {
          title: wasCancelled ? `🚫 ${printerName} cancelled` : `✅ ${printerName} finished`,
          body: jobTitle,
          data: { type: wasCancelled ? "print_error" : "print_finished", printerId: devId, printerName },
        };
      } else if (gcodeState === "FAILED" && (effectivePrev === "RUNNING" || effectivePrev === "PAUSE" || effectivePrev === "PREPARE")) {
        const hmsAlerts = Array.isArray(state.hms) ? state.hms : [];
        let failBody = state.subtask_name || "Print failed";
        if (hmsAlerts.length > 0) {
          const reasons = hmsAlerts.map((h) => lookupHmsError(h.attr, h.code) || formatHmsCode(h.attr, h.code));
          failBody = reasons.join(" | ");
        }
        notification = {
          title: `⚠️ ${printerName} failed`,
          body: failBody,
          data: { type: "print_error", printerId: devId, printerName },
        };
      } else if (gcodeState === "RUNNING" && (effectivePrev === "IDLE" || effectivePrev === "FINISH" || effectivePrev === "FAILED" || effectivePrev === "PREPARE")) {
        // Fetch cover image URL from tasks API for the LA thumbnail
        let coverUrl = null;
        try {
          const { fetchTasks } = require("./bambuClient");
          const freshToken = await ensureFreshToken(user);
          if (freshToken) {
            const tasks = await fetchTasks(freshToken, 5);
            const task = tasks.find(t => t?.deviceId === devId);
            if (task?.cover) coverUrl = task.cover;
            log.info(`[MQTT] Cover for ${devId}: ${coverUrl ? coverUrl.slice(0, 60) + '...' : 'none'}`);
          } else {
            log.warn(`[MQTT] Could not refresh token to fetch cover for ${devId}`);
          }
        } catch (e) {
          log.warn(`[MQTT] Cover fetch failed for ${devId}: ${e.message}`);
        }

        notification = {
          title: `🖨 ${printerName} started printing`,
          body: jobTitle,
          data: { type: "print_started", printerId: devId, printerName, progressPct: state.mc_percent, remainingSec: (state.mc_remaining_time || 0) * 60, coverUrl },
        };
      }

      if (notification && user.expo_push_token) {
        // Include bambuUid so NSE can fetch camera frames
        if (notification.data) notification.data.bambuUid = user.bambu_uid || "";
        await sendPush(user.expo_push_token, notification);
        let apnsSuccess = false;

        // Send Live Activity updates via APNS
        // START uses push-to-start token; UPDATE/END use activity update token
        if (apns.isConfigured()) {
          const nowSec = Math.floor(Date.now() / 1000);
          const remaining = (state.mc_remaining_time || 0) * 60;
          const rawProgress = (state.mc_percent || 0) / 100;
          const progress = (gcodeState === "PREPARE" || (gcodeState === "RUNNING" && effectivePrev === "PREPARE" && rawProgress >= 0.95)) ? 0 : rawProgress;

          try {
            if (notification.data.type === "print_started") {
              // START: use push-to-start token
              if (user.la_push_to_start_token && !skipPushToStart) {
                const contentState = {
                  jobTitle, progress,
                  startTime: nowSec,
                  endTime: remaining > 0 ? nowSec + remaining : nowSec,
                  status: "printing",
                };
                const r = await apns.sendLiveActivityStart(user.la_push_to_start_token, { printerId: devId, printerName }, contentState);
                if (r?.success) apnsSuccess = true;
                log.info(`[MQTT-LA] print_started for ${devId}: ${r?.success ? "sent" : "failed"}`);
              }
            } else if (notification.data.type === "print_finished" || notification.data.type === "print_error") {
              // END: use activity update token
              const actToken = getActivityToken(user, devId);
              if (actToken) {
                const isCancelled = notification.data.type === "print_error";
                const r = await apns.sendLiveActivityEnd(actToken, {
                  jobTitle: isCancelled ? "Cancelled" : jobTitle,
                  progress: isCancelled ? progress : 1.0,
                  startTime: nowSec, endTime: nowSec,
                  status: isCancelled ? "cancelled" : "finished",
                });
                if (r?.success) {
                  apnsSuccess = true;
                  await clearActivityToken(userId, devId); // clean up after successful end
                }
                if (isTokenInvalid(r)) await clearActivityToken(userId, devId);
                log.info(`[MQTT-LA] print_${isCancelled ? "cancelled" : "finished"} for ${devId}: ${r?.success ? "sent" : "failed"}`);
              } else {
                log.warn(`[MQTT-LA] No activity token for ${devId}, cannot end LA`);
              }
            } else {
              // UPDATE (pause, resume): use activity update token
              const actToken = getActivityToken(user, devId);
              if (actToken) {
                const status = gcodeState === "PAUSE" ? "paused" : "printing";
                let laTitle = jobTitle;
                if (gcodeState === "PAUSE") {
                  const hmsAlerts = Array.isArray(state.hms) ? state.hms : [];
                  if (hmsAlerts.length > 0) {
                    const firstReason = lookupHmsError(hmsAlerts[0].attr, hmsAlerts[0].code);
                    if (firstReason) laTitle = firstReason;
                  } else {
                    laTitle = "Paused by user";
                  }
                }
                const contentState = {
                  jobTitle: laTitle, progress,
                  startTime: nowSec,
                  endTime: remaining > 0 ? nowSec + remaining : nowSec,
                  status,
                };
                const r = await apns.sendLiveActivityUpdate(actToken, contentState, 10);
                if (r?.success) apnsSuccess = true;
                if (isTokenInvalid(r)) await clearActivityToken(userId, devId);
                log.info(`[MQTT-LA] ${notification.data.type} for ${devId}: ${progress * 100 | 0}% — ${r?.success ? "sent" : "failed"}`);
              } else {
                log.warn(`[MQTT-LA] No activity token for ${devId}, cannot update LA`);
              }
            }
          } catch (e) {
            log.error(`[MQTT-LA] Error for ${devId}: ${e.message}`);
          }
        }

        // Only mark MQTT as having handled this after successful delivery
        // so the poller can retry if APNs failed
        if (apnsSuccess || !apns.isConfigured()) {
          await PrinterState.findOneAndUpdate(
            { user_id: userId, printer_dev_id: devId },
            { mqtt_last_notif_at: new Date() },
          );
        }
      }
    }
  }
}

const mqttService = new MqttPrinterService();
module.exports = mqttService;
