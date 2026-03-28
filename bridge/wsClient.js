/**
 * WebSocket client that connects to the BambuFarm server.
 * Authenticates as a bridge, sends camera frames, and receives demand signals.
 */

const WebSocket = require("ws");

const MSG_CAMERA_FRAME = 0x01;
const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 30000;
const HEARTBEAT_INTERVAL = 25000;

class BridgeWsClient {
  /**
   * @param {Object} opts
   * @param {string} opts.serverUrl - e.g. "wss://bambufarm.up.railway.app/ws/bridge"
   * @param {string} opts.bambuToken - Bambu Lab access token
   * @param {(printers: string[]) => void} opts.onDemandUpdate - called when server says which printers to stream
   * @param {(state: string) => void} opts.onStateChange
   */
  constructor({ serverUrl, bambuToken, onDemandUpdate, onStateChange }) {
    this.serverUrl = serverUrl;
    this.bambuToken = bambuToken;
    this.onDemandUpdate = onDemandUpdate;
    this.onStateChange = onStateChange;

    this.ws = null;
    this.authenticated = false;
    this.reconnectDelay = RECONNECT_BASE;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.stopped = false;
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
          this.onDemandUpdate(msg.printers || []);
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

    const idBuf = Buffer.from(printerId, "utf8");
    const header = Buffer.alloc(3);
    header[0] = MSG_CAMERA_FRAME;
    header.writeUInt16LE(idBuf.length, 1);

    const frame = Buffer.concat([header, idBuf, jpegData]);
    this.ws.send(frame);
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
