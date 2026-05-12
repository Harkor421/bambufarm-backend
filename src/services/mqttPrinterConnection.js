/**
 * Single Bambu Lab cloud MQTT connection for one user account.
 *
 * Manages the mqtt.js client lifecycle, parses incoming `device/{id}/report`
 * pushes into the in-memory printerStates map, and exposes typed helpers for
 * sending commands (pause/resume/stop/light/etc.). Dispatches state-change
 * and progress-bucket callbacks up to the orchestrator (MqttPrinterService).
 */

const mqttLib = require("mqtt");
const log = require("../utils/logger");

const config = require("../config");
const MQTT_HOST = config.bambu.mqttHost;
const MQTT_PORT = config.bambu.mqttPort;
const PUSHALL_INTERVAL = config.bambu.pushallInterval;
const RECONNECT_DELAY = config.bambu.reconnectDelay;

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
    log.debug(`[MQTT] Connecting user ${this.userId} (uid=${this.bambuUid})...`);

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
        log.debug(`[MQTT] Connected for user ${this.userId} (${this.printerIds.size} printers)`);
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
          log.debug(`[MQTT] Disconnected for user ${this.userId}, will auto-reconnect`);
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
      try {
        this.client.end(true);
      } catch {}
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

  pausePrint(devId) {
    return this.sendCommand(devId, {
      print: { sequence_id: String(this.sequenceId), command: "pause" },
    });
  }

  resumePrint(devId) {
    return this.sendCommand(devId, {
      print: { sequence_id: String(this.sequenceId), command: "resume" },
    });
  }

  stopPrint(devId) {
    return this.sendCommand(devId, {
      print: { sequence_id: String(this.sequenceId), command: "stop" },
    });
  }

  /**
   * Update an AMS slot's filament metadata (color/material/temp). Only takes
   * effect when the printer is IDLE or PAUSE — Bambu rejects this during an
   * active print.
   *
   * @param {string} devId
   * @param {object} params
   * @param {number} params.amsId - AMS unit index (0 = first AMS)
   * @param {number} params.trayId - Slot index within the AMS (0-3)
   * @param {string} params.trayColor - "RRGGBBAA" hex (e.g. "26FF9AFF")
   * @param {string} params.trayType - "PLA" | "PETG" | "ABS" | "TPU" | etc.
   * @param {string} [params.trayInfoIdx] - Bambu filament profile id (e.g. "GFL00")
   * @param {number} [params.nozzleTempMin]
   * @param {number} [params.nozzleTempMax]
   */
  setAmsFilament(devId, params) {
    const result = this.sendCommand(devId, {
      print: {
        sequence_id: String(this.sequenceId),
        command: "ams_filament_setting",
        ams_id: params.amsId ?? 0,
        tray_id: params.trayId ?? 0,
        tray_color: params.trayColor,
        tray_type: params.trayType,
        ...(params.trayInfoIdx ? { tray_info_idx: params.trayInfoIdx } : {}),
        ...(params.nozzleTempMin != null ? { nozzle_temp_min: params.nozzleTempMin } : {}),
        ...(params.nozzleTempMax != null ? { nozzle_temp_max: params.nozzleTempMax } : {}),
      },
    });

    // Bambu's reply to ams_filament_setting only includes the changed slot,
    // not the full state. Request a pushall ~500ms later to get the complete
    // updated state — otherwise our cache could end up with a stale view.
    setTimeout(() => {
      try {
        this.sendCommand(devId, {
          pushing: {
            sequence_id: String(this.sequenceId),
            command: "pushall",
            version: 1,
            push_target: 1,
          },
        });
      } catch {}
    }, 500);

    return result;
  }

  /** Set print speed level (1=Silent, 2=Standard, 3=Sport, 4=Ludicrous) */
  setSpeed(devId, level) {
    return this.sendCommand(devId, {
      print: {
        sequence_id: String(this.sequenceId),
        command: "print_speed",
        param: String(level),
      },
    });
  }

  /** Toggle chamber light */
  setLight(devId, on) {
    return this.sendCommand(devId, {
      system: {
        sequence_id: String(this.sequenceId),
        command: "ledctrl",
        led_node: "chamber_light",
        led_mode: on ? "on" : "off",
        led_on_time: 500,
        led_off_time: 500,
        loop_times: 0,
        interval_time: 0,
      },
    });
  }

  /** Send raw gcode */
  sendGcode(devId, gcode) {
    return this.sendCommand(devId, {
      print: {
        sequence_id: String(this.sequenceId),
        command: "gcode_line",
        param: gcode + "\n",
      },
    });
  }

  /**
   * Send a command and wait for the printer's reply matched by sequence_id.
   * Used to probe which commands Bambu's cloud broker accepts vs silently
   * ignores (i.e., which require the bridge's signing).
   *
   * `subKey` is the top-level field that holds the command ("print", "system",
   * "pushing", "info"). Bambu echoes the command back in the same sub-object
   * with the same sequence_id, often with `result: "success"` or a `reason`.
   *
   * Returns { sent, seq, response, took_ms, error? }. `response: null` after
   * the timeout means Bambu silently dropped the command — usually a sign that
   * signing is required.
   */
  probeCommand(devId, payload, subKey, timeoutMs = 4000) {
    return new Promise((resolve) => {
      if (!this.connected || !this.client) {
        return resolve({
          sent: false,
          seq: null,
          response: null,
          took_ms: 0,
          error: "not connected",
        });
      }
      this.sequenceId++;
      const seq = String(this.sequenceId);
      if (!payload[subKey] || typeof payload[subKey] !== "object") {
        return resolve({
          sent: false,
          seq,
          response: null,
          took_ms: 0,
          error: `payload missing sub-key "${subKey}"`,
        });
      }
      payload[subKey].sequence_id = seq;

      const start = Date.now();
      const expectedTopic = `device/${devId}/report`;
      let done = false;

      const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          this.client.off("message", listener);
        } catch {}
      };

      const listener = (topic, raw) => {
        if (topic !== expectedTopic) return;
        let json;
        try {
          json = JSON.parse(raw.toString());
        } catch {
          return;
        }
        // Match by sequence_id in the same sub-key first, then any sub-object.
        const candidates = [
          json[subKey],
          json.print,
          json.system,
          json.info,
          json.mc_print,
        ].filter(Boolean);
        for (const sub of candidates) {
          if (String(sub.sequence_id) === seq) {
            cleanup();
            return resolve({ sent: true, seq, response: sub, took_ms: Date.now() - start });
          }
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve({ sent: true, seq, response: null, took_ms: Date.now() - start });
      }, timeoutMs);

      this.client.on("message", listener);

      try {
        this.client.publish(`device/${devId}/request`, JSON.stringify(payload));
      } catch (err) {
        cleanup();
        resolve({ sent: false, seq, response: null, took_ms: 0, error: err.message });
      }
    });
  }

  // ── Internal ─────────────────────────────────

  async _handlePublish(topic, payload) {
    // topic = device/{devId}/report
    const match = topic.match(/^device\/([^/]+)\/report$/);
    if (!match) return;
    const devId = match[1];
    if (!this.printerIds.has(devId)) return;

    let json;
    try {
      json = JSON.parse(payload.toString());
    } catch {
      return;
    }
    if (!json.print) return;

    const p = json.print;
    const prev = this.printerStates.get(devId) || {};

    // Merge incremental update into stored state. Top-level is shallow merge
    // (Bambu sends incremental updates per-field), but the `ams` field gets a
    // deeper merge so a partial AMS update doesn't wipe out other slots/units.
    //
    // Without this, sending an ams_filament_setting command causes Bambu to
    // reply with just the changed slot — our shallow merge would replace the
    // whole `ams.ams[]` array, losing every other unit's data and making the
    // entire AMS section vanish from the UI until the next full pushall.
    const merged = { ...prev };
    for (const key of Object.keys(p)) {
      if (p[key] === undefined || p[key] === null) continue;
      if (key === "ams" && prev.ams && typeof p.ams === "object") {
        // Deep-merge ams: keep existing units, overlay any included new ones
        const mergedAms = { ...prev.ams, ...p.ams };
        if (Array.isArray(p.ams.ams) && Array.isArray(prev.ams.ams)) {
          // Merge unit arrays by id — partial updates often only include
          // changed units, so we preserve the others.
          const byId = new Map();
          for (const u of prev.ams.ams) byId.set(u.id, u);
          for (const u of p.ams.ams) {
            const existing = byId.get(u.id);
            if (existing && Array.isArray(existing.tray) && Array.isArray(u.tray)) {
              // Merge tray arrays by id too
              const trayById = new Map();
              for (const t of existing.tray) trayById.set(t.id, t);
              for (const t of u.tray) {
                const existingTray = trayById.get(t.id);
                trayById.set(t.id, existingTray ? { ...existingTray, ...t } : t);
              }
              byId.set(u.id, { ...existing, ...u, tray: [...trayById.values()] });
            } else {
              byId.set(u.id, existing ? { ...existing, ...u } : u);
            }
          }
          mergedAms.ams = [...byId.values()];
        }
        merged.ams = mergedAms;
      } else {
        merged[key] = p[key];
      }
    }
    this.printerStates.set(devId, merged);

    // Detect gcode_state changes
    if (p.gcode_state && p.gcode_state !== prev.gcode_state) {
      log.debug(
        `[MQTT] ${devId}: ${prev.gcode_state || "?"} → ${p.gcode_state} (${merged.mc_percent}%, ${merged.mc_remaining_time}min remaining)`
      );
      try {
        await this.onStateChange(devId, merged, prev.gcode_state);
      } catch (err) {
        log.error(`[MQTT] onStateChange error for ${devId}: ${err.message}\n${err.stack}`);
      }
    }

    // Stash the latest frame if we're in the pre-end window (95-99% progress).
    // The plate lowers AT FINISH, so grabbing the frame then shows empty air —
    // we need a frame from shortly before the end for training/broadcast use.
    try {
      const { maybeStashPreEndFrame } = require("./trainingDataCapture");
      maybeStashPreEndFrame(this.bambuUid, devId, merged);
    } catch {}

    // Push real-time MQTT state to subscribed app clients via WebSocket.
    // Throttled to 1 push per 2 seconds per printer to avoid flooding (Bambu
    // sends multiple raw messages per second). State changes (gcode_state)
    // always push immediately for instant UI feedback.
    try {
      if (!this._lastStatePush) this._lastStatePush = new Map();
      const now = Date.now();
      const lastPush = this._lastStatePush.get(devId) || 0;
      const stateChanged = p.gcode_state && p.gcode_state !== prev.gcode_state;
      if (stateChanged || now - lastPush >= 2000) {
        this._lastStatePush.set(devId, now);
        const wsManager = require("./wsManager");
        const { normalizeMqttState } = require("../utils/normalizeMqttState");
        wsManager.broadcastMqttState(this.bambuUid, devId, normalizeMqttState(merged));
      }
    } catch {}

    // Send LA progress update at 20% boundaries only (0%, 20%, 40%, 60%, 80%, 100%).
    // Apple's APNs budget for Live Activities is ~4-5 priority-10 updates/hour — a
    // 24h print on time-based polling would blow that budget 100x over and get the
    // LA silenced. Progress-based updates = ~6 per print, well within budget.
    if (merged.gcode_state === "RUNNING" && merged.mc_percent != null) {
      const bucket = Math.floor(merged.mc_percent / 20); // 0..5
      if (!this._lastProgressBucket) this._lastProgressBucket = new Map();
      const lastBucket = this._lastProgressBucket.get(devId);
      if (lastBucket == null || bucket > lastBucket) {
        this._lastProgressBucket.set(devId, bucket);
        try {
          if (this.onProgressUpdate) await this.onProgressUpdate(devId, merged);
        } catch (err) {
          log.error(`[MQTT] onProgressUpdate error for ${devId}: ${err.message}`);
        }
      }
    } else if (
      merged.gcode_state &&
      merged.gcode_state !== "RUNNING" &&
      merged.gcode_state !== "PAUSE"
    ) {
      // Print ended (FINISH/IDLE/FAILED) — reset so the next print on this printer
      // starts the bucket progression from 0 again.
      if (this._lastProgressBucket) this._lastProgressBucket.delete(devId);
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
      this.client.publish(
        `device/${devId}/request`,
        JSON.stringify({
          pushing: {
            sequence_id: String(this.sequenceId),
            command: "pushall",
            version: 1,
            push_target: 1,
          },
        })
      );
    }
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

module.exports = PrinterMqttConnection;
