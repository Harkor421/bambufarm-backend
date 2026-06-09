/**
 * WebSocket client that connects to the BambuFarm server.
 * Authenticates as a bridge, sends camera frames, and receives demand signals.
 */

const WebSocket = require("ws");

const MSG_CAMERA_FRAME = 0x01;
const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 30000;
const HEARTBEAT_INTERVAL = 25000;
// Drop frames if we just sent one for this printer in the last N ms. The
// server applies the same throttle on relay, so anything sent faster than
// the server's threshold is wasted ingress. Server pushes the authoritative
// value via demand_update.frameRateHint; this is the conservative default
// before the first hint arrives.
const DEFAULT_FRAME_THROTTLE_MS = 2000;

class BridgeWsClient {
  /**
   * @param {Object} opts
   * @param {string} opts.serverUrl - e.g. "wss://bambufarm.up.railway.app/ws/bridge"
   * @param {string} opts.bambuToken - Bambu Lab access token
   * @param {(printers: string[]) => void} opts.onDemandUpdate - called when server says which printers to stream
   * @param {(state: string) => void} opts.onStateChange
   */
  /**
   * @param {Object} opts
   * @param {string} opts.serverUrl
   * @param {string} opts.bambuToken
   * @param {(printers: string[]) => void} opts.onDemandUpdate
   * @param {(state: string) => void} opts.onStateChange
   * @param {(data: {devId: string, action: string, params: object, requestId: string}) => void} [opts.onCommand]
   */
  constructor({ serverUrl, bambuToken, onDemandUpdate, onStateChange, onCommand }) {
    this.serverUrl = serverUrl;
    this.bambuToken = bambuToken;
    this.onDemandUpdate = onDemandUpdate;
    this.onStateChange = onStateChange;
    this.onCommand = onCommand;

    this.ws = null;
    this.authenticated = false;
    this.reconnectDelay = RECONNECT_BASE;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.stopped = false;
    this.frameThrottleMs = DEFAULT_FRAME_THROTTLE_MS;
    this._lastFrameSentAt = new Map(); // printerId → ms
  }

  connect() {
    if (this.stopped) return;

    this.onStateChange("connecting");

    try {
      this.ws = new WebSocket(this.serverUrl);
    } catch (err) {
      this.onStateChange("error");
      this._scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      // Send auth message
      this.ws.send(JSON.stringify({
        type: "bridge_auth",
        bambuToken: this.bambuToken,
      }));
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "auth_ok") {
          this.authenticated = true;
          this.reconnectDelay = RECONNECT_BASE;
          this.onStateChange("connected");
          this._startHeartbeat();
        } else if (msg.type === "demand_update") {
          if (typeof msg.frameRateHint === "number" && msg.frameRateHint > 0) {
            this.frameThrottleMs = msg.frameRateHint;
          }
          this.onDemandUpdate(msg.printers || []);
        } else if (msg.type === "printer_command" && this.onCommand) {
          this.onCommand(msg);
        }
      } catch {}
    });

    this.ws.on("close", (code, reason) => {
      this.authenticated = false;
      this._stopHeartbeat();
      const reasonStr = reason ? reason.toString() : "";
      console.log(`[WS] Closed: code=${code}${reasonStr ? ` reason=${reasonStr}` : ""}`);
      this.onStateChange("disconnected");
      this._scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error(`[WS] Error: ${err.message}`);
      // close event will follow
    });
  }

  /**
   * Send a camera frame to the server.
   * @param {string} printerId
   * @param {Buffer} jpegData
   */
  sendFrame(printerId, jpegData) {
    if (!this.authenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Drop frames faster than the server's relay throttle — they'd just be
    // discarded server-side, wasting upload bandwidth on the user's connection
    // and ingress on the server.
    const now = Date.now();
    const last = this._lastFrameSentAt.get(printerId) || 0;
    if (now - last < this.frameThrottleMs) return;
    this._lastFrameSentAt.set(printerId, now);

    const idBuf = Buffer.from(printerId, "utf8");
    const header = Buffer.alloc(3);
    header[0] = MSG_CAMERA_FRAME;
    header.writeUInt16LE(idBuf.length, 1);

    const frame = Buffer.concat([header, idBuf, jpegData]);
    this.ws.send(frame);
  }

  /**
   * Send command result back to server.
   */
  sendCommandResult(requestId, success, error) {
    if (!this.authenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type: "command_result",
      requestId,
      success,
      error: error || null,
    }));
  }

  stop() {
    this.stopped = true;
    this._stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, RECONNECT_MAX);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

module.exports = { BridgeWsClient };
