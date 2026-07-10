/**
 * Single Bambu Lab cloud MQTT connection for one user account.
 *
 * Manages the mqtt.js client lifecycle, parses incoming `device/{id}/report`
 * pushes into the in-memory printerStates map, and exposes typed helpers for
 * sending commands (pause/resume/stop/light/etc.). Dispatches state-change
 * and progress-bucket callbacks up to the orchestrator (MqttPrinterService).
 */

const mqttLib = require("mqtt");
const axios = require("axios");
const log = require("../utils/logger");

const config = require("../config");
const MQTT_HOST = config.bambu.mqttHost;
const MQTT_PORT = config.bambu.mqttPort;
const PUSHALL_INTERVAL = config.bambu.pushallInterval;
const RECONNECT_DELAY = config.bambu.reconnectDelay;
const BAMBU_API = config.bambu.apiBase;
// How often a live connection re-fetches the account's bound-device list, so
// printers that were offline when the connection was first built get picked
// up without waiting for a server restart.
// 15 min (not 5): each live connection re-polls Bambu's /user/bind on this
// timer, so at 10k connections a 5-min interval sustained ~33 req/s to Bambu's
// API — a fleet-wide rate-limit (429) hazard. 15 min cuts that ~3× (~11 req/s).
// Discovery latency only affects printers that were OFFLINE at connect time (the
// full device list is fetched immediately on connect); newly-powered printers
// just take up to 15 min to appear instead of 5. Removing this timer entirely
// (deferred) needs the poller to add printerIds to live connections first.
const BIND_REFRESH_INTERVAL = 15 * 60 * 1000;
// Offline detection. We sweep every minute; a printer is considered offline
// when we haven't heard a report for longer than OFFLINE_THRESHOLD. The
// threshold is 2 missed pushall cycles + a buffer, so a single dropped pushall
// (or a momentarily slow printer) never produces a false "offline" alert.
const OFFLINE_SWEEP_INTERVAL = 60 * 1000;
const OFFLINE_THRESHOLD = PUSHALL_INTERVAL * 2 + 60 * 1000;

class PrinterMqttConnection {
  constructor({ userId, bambuUid, accessToken, printerIds, onStateChange, onProgressUpdate, onOffline }) {
    this.userId = userId;
    this.bambuUid = bambuUid;
    this.accessToken = accessToken;
    this.printerIds = printerIds; // Set of dev_ids
    this.onStateChange = onStateChange;
    this.onProgressUpdate = onProgressUpdate;
    this.onOffline = onOffline; // called once when a previously-seen printer goes silent
    this.socket = null;
    this.connected = false;
    this.connectedAt = 0;
    this.buf = Buffer.alloc(0);
    this.pushallTimer = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.bindRefreshTimer = null;
    this.offlineSweepTimer = null;
    this.stopped = false;
    this.printerStates = new Map(); // devId → { gcode_state, mc_percent, mc_remaining_time, ... }
    // Offline detection. lastReportAt is set ONLY when a printer actually
    // reports — so a printer that was already offline when we connected (never
    // reports) is never eligible, and we only ever fire on a real
    // online→offline transition. offlineNotified dedups to "once per episode".
    this.lastReportAt = new Map(); // devId → ts of last report
    this.offlineNotified = new Set(); // devIds we've already pushed an offline alert for
    this.sequenceId = 0;
    // Per-connection reconnect jitter (10-40s). At 10k connections a broker blip
    // would otherwise trigger a synchronized TLS-handshake storm every
    // RECONNECT_DELAY; the random spread flattens it.
    this.reconnectPeriod = RECONNECT_DELAY + Math.floor(Math.random() * 30000);
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
        reconnectPeriod: this.reconnectPeriod,
        keepalive: 30,
      });

      // Admin probes attach a transient per-call "message" listener (always
      // removed in their cleanup). A burst of probes can briefly exceed Node's
      // default 10-listener ceiling and emit a noisy MaxListenersExceededWarning;
      // raise the cap so the warning doesn't fire. Not a leak — listeners are
      // cleaned up on match/timeout.
      this.client.setMaxListeners(50);

      this.client.on("connect", () => {
        this.connected = true;
        this.connectedAt = Date.now();
        this.socket = this.client.stream; // for dead-connection check
        log.debug(`[MQTT] Connected for user ${this.userId} (${this.printerIds.size} printers)`);
        this._subscribeAll();
        // Request full state for all printers
        setTimeout(() => this._pushallAll(), 1000);
        // Periodic pushall
        this.pushallTimer = setInterval(() => this._pushallAll(), PUSHALL_INTERVAL);
        // Offline sweep — fire onOffline once for any printer that stops reporting.
        this.offlineSweepTimer = setInterval(() => this._checkOffline(), OFFLINE_SWEEP_INTERVAL);
        // Periodically re-fetch the bound-device list so a printer that was
        // offline at connect time gets subscribed without a server restart.
        this.bindRefreshTimer = setInterval(
          () => this._refreshPrinterList(),
          BIND_REFRESH_INTERVAL
        );
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
    } catch (err) {
      // Without logging, a broken control endpoint (pause/resume/AMS) returns
      // `false` silently and the caller has no way to know what went wrong.
      log.warn(`[MQTT] publish failed for ${devId}: ${err.message}`);
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

    // Any report means the printer is alive. Record it for offline detection,
    // and if it had been flagged offline, clear the flag so a future
    // online→offline transition fires a fresh alert.
    this.lastReportAt.set(devId, Date.now());
    this.offlineNotified.delete(devId);

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
    } catch (err) {
      // Non-critical: training capture must not break the MQTT pipeline.
      log.debug(`[MQTT] maybeStashPreEndFrame failed for ${devId}: ${err.message}`);
    }

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
    } catch (err) {
      // Don't let a broadcast failure poison the MQTT state machine — but
      // do log so a silently-broken WS push path is debuggable.
      log.debug(`[MQTT] broadcastMqttState failed for ${devId}: ${err.message}`);
    }

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

  /**
   * Re-fetch the account's bound-device list and subscribe any printers that
   * weren't in the original snapshot. Fixes the bug where a printer offline
   * when the connection was first built stayed invisible — never subscribed,
   * its reports dropped by _handlePublish — until a full server restart.
   *
   * Add-only: newly-bound printers get a subscribe + a pushall to fetch their
   * current state. Removed printers are left alone (harmless, and avoids
   * unsubscribe races). Best-effort — a failed fetch just retries next tick.
   */
  async _refreshPrinterList() {
    if (this.stopped || !this.client || !this.connected) return;
    let devices;
    try {
      const resp = await axios.get(`${BAMBU_API}/v1/iot-service/api/user/bind`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        timeout: 10000,
      });
      devices = resp.data?.devices || [];
    } catch (err) {
      log.warn(`[MQTT] printer-list refresh failed for user ${this.userId}: ${err.message}`);
      return;
    }
    let added = 0;
    for (const d of devices) {
      const devId = d?.dev_id;
      if (!devId || this.printerIds.has(devId)) continue;
      this.printerIds.add(devId);
      this.client.subscribe(`device/${devId}/report`);
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
      added++;
    }
    if (added > 0) {
      log.debug(
        `[MQTT] user ${this.userId}: printer-list refresh subscribed ${added} new printer(s) (now ${this.printerIds.size})`
      );
    }
  }

  /**
   * Fire onOffline ONCE for any printer we've heard from that has now gone
   * silent past OFFLINE_THRESHOLD. Re-arms automatically when the printer
   * reports again (see _handlePublish).
   */
  _checkOffline() {
    // Don't flag printers offline while OUR own MQTT link is down — that's our
    // problem, not the printer's. And give a grace window after each (re)connect
    // so the first pushall responses can land before we judge anyone offline.
    if (!this.connected) return;
    if (Date.now() - this.connectedAt < OFFLINE_THRESHOLD) return;

    const now = Date.now();
    for (const [devId, ts] of this.lastReportAt) {
      if (this.offlineNotified.has(devId)) continue;
      if (now - ts > OFFLINE_THRESHOLD) {
        this.offlineNotified.add(devId);
        log.info(`[MQTT] ${devId} went offline (no report for ${Math.round((now - ts) / 1000)}s)`);
        Promise.resolve(this.onOffline?.(devId)).catch((e) =>
          log.warn(`[MQTT] onOffline handler error for ${devId}: ${e.message}`)
        );
      }
    }
  }

  _stopTimers() {
    if (this.pushallTimer) clearInterval(this.pushallTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.bindRefreshTimer) clearInterval(this.bindRefreshTimer);
    if (this.offlineSweepTimer) clearInterval(this.offlineSweepTimer);
    this.pushallTimer = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.bindRefreshTimer = null;
    this.offlineSweepTimer = null;
  }
}

module.exports = PrinterMqttConnection;
