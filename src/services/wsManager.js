const { WebSocketServer } = require("ws");
const log = require("../utils/logger");

/**
 * WebSocket manager for camera frame relay.
 *
 * Two client types:
 *   - Bridge: runs on user's LAN, authenticates with Bambu access token, sends binary JPEG frames
 *   - App: mobile app, authenticates with Bambu access token, receives JPEG frames
 *
 * Both identify by their Bambu uid (fetched from Bambu Cloud on auth).
 *
 * Binary frame format (bridge → server → app):
 *   Byte 0:       message type (0x01 = camera frame)
 *   Bytes 1-2:    printerId length (uint16 LE)
 *   Bytes 3..N:   printerId (UTF-8)
 *   Bytes N+1..:  JPEG payload
 */

const https = require("https");
const crypto = require("crypto");

const MSG_CAMERA_FRAME = 0x01;

// Shared HTTPS agent with connection pooling — reuses TCP connections to Bambu API
// instead of opening a fresh socket per auth call (fixes socket exhaustion under load).
const bambuHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 25,
  maxFreeSockets: 10,
  timeout: 10000,
  keepAliveMsecs: 30000,
});

// Token verification cache: tokenHash → { uid, expiresAt }
// Avoids hammering Bambu API when the same bridge reconnects repeatedly.
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function getCachedUid(token) {
  const key = hashToken(token);
  const entry = tokenCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokenCache.delete(key);
    return null;
  }
  return entry.uid;
}

function cacheUid(token, uid) {
  const key = hashToken(token);
  tokenCache.set(key, { uid, expiresAt: Date.now() + TOKEN_CACHE_TTL });
  // Prevent unbounded growth — cap at 1000 entries
  if (tokenCache.size > 1000) {
    const firstKey = tokenCache.keys().next().value;
    tokenCache.delete(firstKey);
  }
}

/**
 * Decode a JWT payload (handles base64url encoding properly).
 */
function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return JSON.parse(Buffer.from(b64, "base64").toString());
  } catch {
    return null;
  }
}

/**
 * Verify a Bambu access token by calling the Bambu Cloud API.
 * Returns the uid string on success, or null on failure.
 * Uses a 10min cache + pooled HTTPS agent to survive high reconnect load.
 */
function verifyBambuToken(accessToken) {
  return new Promise((resolve) => {
    // Fast path: cached uid for this exact token
    const cached = getCachedUid(accessToken);
    if (cached) return resolve(cached);

    const handleResponse = (res, body, uidFromJwt) => {
      const status = res.statusCode;
      if (status === 200) {
        if (uidFromJwt) {
          cacheUid(accessToken, uidFromJwt);
          return resolve(String(uidFromJwt));
        }
        try {
          const data = JSON.parse(body);
          const uid = data.uid || data.userId || data.user_id || data.id ||
            (data.data && (data.data.uid || data.data.userId || data.data.id));
          if (uid) {
            cacheUid(accessToken, String(uid));
            return resolve(String(uid));
          }
          log.warn(`[WS] Profile 200 but no uid in response: keys=${Object.keys(data).join(",")}`);
          return resolve(null);
        } catch {
          return resolve(null);
        }
      }
      // Log specific error codes so we can see rate-limiting / outages
      if (status === 429) log.warn(`[WS] Bambu API rate-limited (429) on token verify`);
      else if (status >= 500) log.warn(`[WS] Bambu API error ${status} on token verify`);
      else if (status === 401 || status === 403) log.info(`[WS] Bambu token rejected (${status})`);
      else log.warn(`[WS] Bambu API unexpected status ${status} on token verify`);
      resolve(null);
    };

    const makeRequest = (path, uidFromJwt) => {
      const req = https.request(
        {
          hostname: "api.bambulab.com",
          path,
          method: "GET",
          agent: bambuHttpsAgent,
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => handleResponse(res, body, uidFromJwt));
        }
      );
      req.on("error", (err) => {
        log.warn(`[WS] Bambu API network error on token verify: ${err.message}`);
        resolve(null);
      });
      req.setTimeout(10000, () => {
        log.warn(`[WS] Bambu API timeout on token verify (${path})`);
        req.destroy();
        resolve(null);
      });
      req.end();
    };

    // Try JWT decode first — if we get a uid we just need to verify the token is valid
    const payload = decodeJwtPayload(accessToken);
    const uidFromJwt = payload && (payload.uid || payload.sub || payload.user_id);
    if (uidFromJwt) {
      makeRequest("/v1/iot-service/api/user/bind", uidFromJwt);
    } else {
      makeRequest("/v1/user-service/my/profile", null);
    }
  });
}

class WsManager {
  constructor() {
    this._printerStateGetter = null; // set via setPrinterStateGetter()

    // Last-sent demand signature per user, so we don't resend identical sets.
    // Prevents log spam and camera disconnect/reconnect cycles when MQTT state
    // changes fire without actually changing the demanded printer set.
    this._lastDemandSig = new Map();

    // Hysteresis: when a printer leaves the active state set, keep it demanded
    // for a grace window so brief MQTT flickers (RUNNING→IDLE→RUNNING in a few
    // seconds) don't cause camera disconnect/reconnect cycles.
    // Map<`${uid}:${printerId}`, expiresAtMs>
    this._demandGrace = new Map();
    this._DEMAND_GRACE_MS = 90 * 1000;

    // Listen for state changes to update bridge camera demand
    const eventBus = require("./eventBus");
    eventBus.on("printer:stateChange", ({ bambuUid }) => {
      this._notifyBridgeDemand(bambuUid);
    });

    // Sweep expired grace entries every 30s and re-send demand if anything dropped
    this._graceSweepInterval = setInterval(() => this._sweepDemandGrace(), 30000);

    /** @type {Map<string, Set<import('ws')>>} bambuUid → Set of bridge WS connections */
    this.bridges = new Map();

    /** @type {Map<string, Set<import('ws')>>} bambuUid → Set of app WS connections */
    this.appClients = new Map();

    /** @type {Map<import('ws'), { userId: string, subscribedPrinters: Set<string> }>} */
    this.appMeta = new Map();

    /** @type {Map<import('ws'), string>} bridge ws → bambuUid */
    this.bridgeMeta = new Map();

    /** @type {Set<import('ws')>} public website clients (no auth required) */
    this.publicClients = new Set();

    /** @type {Map<string, Map<string, Buffer>>} bambuUid → (printerId → latest JPEG) */
    this.latestFrames = new Map();

    this.wss = null;
  }

  attach(server) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;

      if (path === "/ws/bridge" || path === "/ws/app" || path === "/ws/public/cameras") {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this._onConnection(ws, req, path);
        });
      } else {
        socket.destroy();
      }
    });

    // Heartbeat every 30s
    this._heartbeatInterval = setInterval(() => {
      if (!this.wss) return;
      for (const ws of this.wss.clients) {
        if (ws._isAlive === false) { ws.terminate(); continue; }
        ws._isAlive = false;
        ws.ping();
      }
    }, 30000);

    log.info("[WS] WebSocket manager attached");
  }

  _onConnection(ws, req, path) {
    ws._isAlive = true;
    ws.on("pong", () => { ws._isAlive = true; });

    if (path === "/ws/bridge") {
      this._handleBridge(ws, req);
    } else if (path === "/ws/app") {
      this._handleApp(ws, req);
    } else if (path === "/ws/public/cameras") {
      this._handlePublicCamera(ws, req);
    }
  }

  // ─── Bridge connections ────────────────────────────────

  _handleBridge(ws, req) {
    let authenticated = false;
    let userId = null;

    const authTimeout = setTimeout(() => {
      if (!authenticated) ws.close(4001, "Auth timeout");
    }, 30000);

    ws.on("message", (data, isBinary) => {
      if (!authenticated) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "bridge_auth" && msg.bambuToken) {
            // Verify token against Bambu Cloud
            verifyBambuToken(msg.bambuToken).then((uid) => {
              if (!uid) {
                ws.close(4003, "Invalid Bambu token");
                return;
              }
              authenticated = true;
              userId = uid;
              clearTimeout(authTimeout);

              this.bridgeMeta.set(ws, userId);
              if (!this.bridges.has(userId)) this.bridges.set(userId, new Set());
              this.bridges.get(userId).add(ws);

              ws.send(JSON.stringify({ type: "auth_ok", userId }));
              log.info(`[WS] Bridge connected for uid ${userId}`);
              this._sendDemandUpdate(ws, userId);
              this._notifyBridgeStatus(userId, true);

              // Track bridge session in DB
              const BridgeSession = require("../db/models/BridgeSession");
              BridgeSession.create({ bambu_uid: userId, connected_at: new Date() })
                .then((s) => { ws._bridgeSessionId = s._id; })
                .catch(() => {});
            });
          } else {
            ws.close(4002, "Invalid auth");
          }
        } catch {
          ws.close(4002, "Invalid auth message");
        }
        return;
      }

      if (isBinary && data.length > 3) {
        this._relayFrame(userId, data);
      } else if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "command_result" && msg.requestId) {
            const cb = this._commandCallbacks?.get(msg.requestId);
            if (cb) {
              cb(msg.success, msg.error);
              this._commandCallbacks.delete(msg.requestId);
            }
          }
        } catch {}
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      if (userId) {
        // Close bridge session in DB
        if (ws._bridgeSessionId) {
          const BridgeSession = require("../db/models/BridgeSession");
          BridgeSession.updateOne(
            { _id: ws._bridgeSessionId },
            { disconnected_at: new Date(), last_active_at: new Date() }
          ).catch(() => {});
        }
        this.bridgeMeta.delete(ws);
        const set = this.bridges.get(userId);
        if (set) { set.delete(ws); if (set.size === 0) this.bridges.delete(userId); }
        // Clear last-sent demand signature so next reconnect gets a fresh full update
        if (!this.isBridgeConnected(userId)) this._lastDemandSig.delete(userId);
        // Clean up cached frames and throttle entries for this user
        if (!this.isBridgeConnected(userId)) {
          this.latestFrames.delete(userId);
          if (this._frameThrottle) {
            for (const key of this._frameThrottle.keys()) {
              if (key.startsWith(`${userId}:`)) this._frameThrottle.delete(key);
            }
          }
        }
        log.info(`[WS] Bridge disconnected for uid ${userId}`);
        this._notifyBridgeStatus(userId, this.isBridgeConnected(userId));
      }
    });

    ws.on("error", (err) => log.error(`[WS] Bridge error: ${err.message}`));
  }

  _relayFrame(userId, data) {
    if (data[0] !== MSG_CAMERA_FRAME || data.length < 4) return;

    const printerIdLen = data[1] | (data[2] << 8);
    if (data.length < 3 + printerIdLen) return;
    const printerId = data.slice(3, 3 + printerIdLen).toString("utf8");
    const jpegPayload = data.slice(3 + printerIdLen);

    // Throttle: skip frame if last relay was < 2s ago (saves ~100-150 GB/month egress)
    const throttleKey = `${userId}:${printerId}`;
    const now = Date.now();
    const lastRelay = this._frameThrottle?.get(throttleKey) || 0;
    if (now - lastRelay < 2000) return; // skip, too soon
    if (!this._frameThrottle) this._frameThrottle = new Map();
    this._frameThrottle.set(throttleKey, now);

    // Cache latest frame for public endpoint
    if (!this.latestFrames.has(userId)) this.latestFrames.set(userId, new Map());
    const userFrames = this.latestFrames.get(userId);
    const isNewCamera = !userFrames.has(printerId);
    userFrames.set(printerId, jpegPayload);

    // Broadcast to public clients if this is the public UID
    const publicUid = process.env.PUBLIC_CAMERA_UID;
    if (publicUid && userId === publicUid && this.publicClients.size > 0) {
      // If a new camera appeared, send updated camera list to all public clients
      if (isNewCamera) {
        const printers = this.getAvailableCameras(publicUid);
        const msg = JSON.stringify({ type: "ready", printers });
        for (const publicWs of this.publicClients) {
          if (publicWs.readyState === 1) publicWs.send(msg);
        }
        log.debug(`[WS] New public camera ${printerId}, notified ${this.publicClients.size} public client(s)`);
      }

      // Relay binary frame to subscribed public clients
      for (const publicWs of this.publicClients) {
        if (publicWs.readyState === 1 && publicWs._publicPrinters && publicWs._publicPrinters.has(printerId)) {
          publicWs.send(data, { binary: true });
        }
      }
    }

    const clients = this.appClients.get(userId);
    if (!clients) return;

    for (const appWs of clients) {
      const meta = this.appMeta.get(appWs);
      if (meta && meta.subscribedPrinters.has(printerId) && appWs.readyState === 1) {
        appWs.send(data, { binary: true });
      }
    }
  }

  /**
   * Get the latest JPEG frame for a specific user and printer.
   * Used by the public camera endpoint.
   */
  getLatestFrame(userId, printerId) {
    const userFrames = this.latestFrames.get(userId);
    if (!userFrames) return null;
    return userFrames.get(printerId) || null;
  }

  /**
   * Get all printer IDs that have cached frames for a user.
   */
  getAvailableCameras(userId) {
    const userFrames = this.latestFrames.get(userId);
    if (!userFrames) return [];
    return Array.from(userFrames.keys());
  }

  // ─── App connections ───────────────────────────────────

  _handleApp(ws, req) {
    let authenticated = false;
    let userId = null;

    const authTimeout = setTimeout(() => {
      if (!authenticated) ws.close(4001, "Auth timeout");
    }, 15000);

    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (!authenticated) {
        if (msg.type === "app_auth" && msg.bambuToken) {
          verifyBambuToken(msg.bambuToken).then((uid) => {
            if (!uid) {
              ws.close(4003, "Invalid Bambu token");
              return;
            }
            authenticated = true;
            userId = uid;
            clearTimeout(authTimeout);

            this.appMeta.set(ws, { userId, subscribedPrinters: new Set() });
            if (!this.appClients.has(userId)) this.appClients.set(userId, new Set());
            this.appClients.get(userId).add(ws);

            const bridgeOnline = this.isBridgeConnected(uid);
            ws.send(JSON.stringify({ type: "auth_ok", userId, bridgeOnline }));
            log.info(`[WS] App connected for uid ${userId} (bridge: ${bridgeOnline ? "online" : "offline"})`);
          });
        } else {
          ws.close(4002, "Invalid auth");
        }
        return;
      }

      // JSON ping from RN clients (can't use native ping/pong)
      if (msg.type === "ping") {
        ws._isAlive = true;
        return;
      }

      if (msg.type === "subscribe_camera" && msg.printerId) {
        const meta = this.appMeta.get(ws);
        if (meta) {
          meta.subscribedPrinters.add(msg.printerId);
          log.debug(`[WS] App subscribed to camera ${msg.printerId}`);
          this._notifyBridgeDemand(userId);
        }
      } else if (msg.type === "unsubscribe_camera" && msg.printerId) {
        const meta = this.appMeta.get(ws);
        if (meta) {
          meta.subscribedPrinters.delete(msg.printerId);
          log.debug(`[WS] App unsubscribed from camera ${msg.printerId}`);
          this._notifyBridgeDemand(userId);
        }
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      if (userId) {
        this.appMeta.delete(ws);
        const set = this.appClients.get(userId);
        if (set) { set.delete(ws); if (set.size === 0) this.appClients.delete(userId); }
        log.info(`[WS] App disconnected for uid ${userId}`);
        this._notifyBridgeDemand(userId);
      }
    });

    ws.on("error", (err) => log.error(`[WS] App error: ${err.message}`));
  }

  // ─── Public camera connections (no auth) ─────────────

  _handlePublicCamera(ws, req) {
    const publicUid = process.env.PUBLIC_CAMERA_UID;
    if (!publicUid) {
      ws.close(4001, "Public camera feed not configured");
      return;
    }

    this.publicClients.add(ws);
    log.debug("[WS] Public camera client connected");

    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      // Client sends init with printer list → subscribe and trigger bridge demand
      if (msg.type === "init" && Array.isArray(msg.printers)) {
        // Register public client's subscribed printers for demand tracking
        ws._publicPrinters = new Set(msg.printers);
        this._notifyBridgeDemand(publicUid);

        const printers = this.getAvailableCameras(publicUid);
        ws.send(JSON.stringify({ type: "ready", printers }));
        log.debug(`[WS] Public client subscribed to ${msg.printers.length} cameras, ${printers.length} available`);
      } else if (msg.type === "ping") {
        ws._isAlive = true;
      }
    });

    ws.on("close", () => {
      this.publicClients.delete(ws);
      log.debug("[WS] Public camera client disconnected");
      this._notifyBridgeDemand(publicUid);
    });

    ws.on("error", (err) => log.error(`[WS] Public camera error: ${err.message}`));

    // Send initial ready message with available cameras
    const printers = this.getAvailableCameras(publicUid);
    ws.send(JSON.stringify({ type: "ready", printers }));
  }

  // ─── Demand tracking ───────────────────────────────────

  _getDemandedPrinters(userId) {
    const demanded = new Set();
    const now = Date.now();

    // Always stream cameras for printers that are currently printing
    if (this._printerStateGetter) {
      try {
        const states = this._printerStateGetter(userId);
        for (const [devId, state] of Object.entries(states)) {
          const active =
            state.gcode_state === "RUNNING" ||
            state.gcode_state === "PAUSE" ||
            state.gcode_state === "PREPARE";
          if (active) {
            demanded.add(devId);
            // Refresh grace window so this printer stays demanded for 90s after it goes idle
            this._demandGrace.set(`${userId}:${devId}`, now + this._DEMAND_GRACE_MS);
          }
        }
      } catch {}
    }

    // Include printers still within their grace window (hysteresis)
    for (const [key, expiresAt] of this._demandGrace) {
      if (!key.startsWith(`${userId}:`)) continue;
      if (expiresAt <= now) {
        this._demandGrace.delete(key);
        continue;
      }
      const devId = key.slice(userId.length + 1);
      demanded.add(devId);
    }

    // App clients
    const clients = this.appClients.get(userId);
    if (clients) {
      for (const appWs of clients) {
        const meta = this.appMeta.get(appWs);
        if (meta) for (const id of meta.subscribedPrinters) demanded.add(id);
      }
    }
    // Public clients (count towards demand for public UID)
    const publicUid = process.env.PUBLIC_CAMERA_UID;
    if (publicUid && userId === publicUid) {
      for (const publicWs of this.publicClients) {
        if (publicWs._publicPrinters) {
          for (const id of publicWs._publicPrinters) demanded.add(id);
        }
      }
    }
    return demanded;
  }

  /**
   * Sweep grace entries that have expired and notify bridges if the set shrank.
   * Runs periodically because a printer going idle may not trigger any further
   * state-change events — we need an independent tick to drop it from demand.
   */
  _sweepDemandGrace() {
    const now = Date.now();
    const affectedUsers = new Set();
    for (const [key, expiresAt] of this._demandGrace) {
      if (expiresAt <= now) {
        this._demandGrace.delete(key);
        const uid = key.split(":", 1)[0];
        affectedUsers.add(uid);
      }
    }
    for (const uid of affectedUsers) this._notifyBridgeDemand(uid);
  }

  _notifyBridgeDemand(userId) {
    const bridges = this.bridges.get(userId);
    if (!bridges || bridges.size === 0) return;

    // Sort to get a stable signature — otherwise Set iteration order changes
    // fire spurious updates that disconnect/reconnect cameras.
    const demanded = this._getDemandedPrinters(userId);
    const printerList = Array.from(demanded).sort();
    const sig = printerList.join(",");

    // Skip if the set hasn't actually changed since the last notification.
    if (this._lastDemandSig.get(userId) === sig) return;
    this._lastDemandSig.set(userId, sig);

    log.debug(`[WS] demand_update → ${bridges.size} bridge(s): ${printerList.length} printer(s)`);
    const msg = JSON.stringify({ type: "demand_update", printers: printerList });
    for (const bridgeWs of bridges) {
      if (bridgeWs.readyState === 1) bridgeWs.send(msg);
    }
  }

  _sendDemandUpdate(bridgeWs, userId) {
    const demanded = this._getDemandedPrinters(userId);
    const printerList = Array.from(demanded).sort();
    this._lastDemandSig.set(userId, printerList.join(","));
    bridgeWs.send(JSON.stringify({ type: "demand_update", printers: printerList }));
  }

  isBridgeConnected(userId) {
    const set = this.bridges.get(userId);
    return set ? set.size > 0 : false;
  }

  /**
   * Notify all app clients for a user when their bridge status changes.
   */
  _notifyBridgeStatus(userId, online) {
    const clients = this.appClients.get(userId);
    if (!clients) return;
    const msg = JSON.stringify({ type: "bridge_status", online });
    for (const ws of clients) {
      try { ws.send(msg); } catch {}
    }
    log.debug(`[WS] Notified ${clients.size} app client(s) — bridge ${online ? "online" : "offline"} for uid ${userId}`);
  }

  /**
   * Send a printer command via bridge relay.
   * @param {string} userId - Bambu UID
   * @param {string} devId - Printer device ID
   * @param {string} action - "pause", "resume", "stop", "speed", "light", "gcode"
   * @param {object} params - Action-specific parameters
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  sendPrinterCommand(userId, devId, action, params = {}) {
    return new Promise((resolve) => {
      const bridges = this.bridges.get(userId);
      if (!bridges || bridges.size === 0) {
        return resolve({ success: false, error: "No bridge connected" });
      }

      if (!this._commandCallbacks) this._commandCallbacks = new Map();
      const requestId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Set timeout for response
      const timeout = setTimeout(() => {
        this._commandCallbacks.delete(requestId);
        resolve({ success: false, error: "Bridge command timeout" });
      }, 10000);

      this._commandCallbacks.set(requestId, (success, error) => {
        clearTimeout(timeout);
        resolve({ success, error });
      });

      const msg = JSON.stringify({
        type: "printer_command",
        requestId,
        devId,
        action,
        params,
      });

      // Send to first available bridge
      for (const bridgeWs of bridges) {
        if (bridgeWs.readyState === 1) {
          bridgeWs.send(msg);
          log.info(`[WS] Command ${action} → ${devId} sent via bridge`);
          return;
        }
      }

      clearTimeout(timeout);
      this._commandCallbacks.delete(requestId);
      resolve({ success: false, error: "Bridge WebSocket not open" });
    });
  }

  /**
   * Set the function used to get printer states (avoids circular dep with mqttPrinterService).
   * @param {(uid: string) => object} fn
   */
  setPrinterStateGetter(fn) {
    this._printerStateGetter = fn;
  }

  close() {
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    if (this._graceSweepInterval) clearInterval(this._graceSweepInterval);
    if (this.wss) this.wss.close();
  }
}

const wsManager = new WsManager();
module.exports = wsManager;
