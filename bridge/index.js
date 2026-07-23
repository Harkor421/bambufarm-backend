#!/usr/bin/env node

/**
 * BambuBridge
 *
 * A desktop app that runs on your PC (same network as your printers).
 * 1. Log in with your Bambu Lab account
 * 2. Click "Start Bridge" — it auto-discovers printers and starts relaying
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const bambuCloud = require("./bambuCloud");
const { scanAndMatch, getLocalIp } = require("./networkScanner");
const { createCameraStream } = require("./cameraStream");
const { createRtspCameraStream } = require("./rtspCameraStream");
const { BridgeWsClient } = require("./wsClient");
const { PrinterMqttControl } = require("./mqttControl");
const onvif = require("./onvifDiscovery");
const { createSnapshotPuller, fetchSnapshot } = require("./cameraSnapshotPuller");
const {
  getRetryDelay,
  recordFailure,
  clearFailures,
  clearAllFailures,
  isSuspended,
  getFailureCount,
} = require("./cameraRetry");
const crypto = require("crypto");

const UI_PORT = 8095;

// Store config in user's home directory so it works when packaged with pkg
// Migrate old config directory if it exists
const OLD_CONFIG_DIR = path.join(os.homedir(), ".bambufarm-bridge");
const CONFIG_DIR = path.join(os.homedir(), ".bambubridge");
if (!fs.existsSync(CONFIG_DIR) && fs.existsSync(OLD_CONFIG_DIR)) {
  try { fs.renameSync(OLD_CONFIG_DIR, CONFIG_DIR); } catch {}
}
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
const CONFIG_PATH = path.join(CONFIG_DIR, "bridge.config.json");

// ─── State ───────────────────────────────────────────────

const DEFAULT_SERVER_URL = "wss://bambufarm-api-production.up.railway.app/ws/bridge";

let config = {
  bambuTokens: null, // { accessToken, refreshToken, expiresAt }
  printers: [],      // [{ devId, name, ip, accessCode }]
  cameras: [],       // [{ id, name, brand?, model?, ip?, snapshotUrl, username?, password?, boundPrinterId?, addedAt }]
};

let bridgeRunning = false;
let wsClient = null;
let wsState = "disconnected";
const activeStreams = new Map();    // devId → { stop }
const streamStates = new Map();    // devId → state string
let demandedPrinters = new Set();
const mqttControl = new PrinterMqttControl();
let scanProgress = null;           // { message, progress } or null
let loginPending = null;           // { email } if waiting for 2FA code

// IP camera scan + streaming state
let cameraScanState = null;        // { running, progress, found } or null
const cameraStreams = new Map();   // cameraId → { stop }
const cameraStreamStates = new Map(); // cameraId → state string

// ─── Config persistence ──────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
    }
  } catch {}
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch {}
}

// ─── Bambu Cloud Auth ────────────────────────────────────

async function getAccessToken() {
  if (!config.bambuTokens) return null;

  // Refresh if expired (with 60s buffer)
  if (Date.now() > config.bambuTokens.expiresAt - 60000) {
    try {
      config.bambuTokens = await bambuCloud.refreshToken(config.bambuTokens.refreshToken);
      saveConfig();
      console.log("[Auth] Token refreshed");
    } catch (err) {
      // Refresh is BEST-EFFORT. Bambu is known to 401 the refresh endpoint even
      // when the current access token is still valid, so a refresh failure must
      // NOT log the user out. Nulling the tokens here silently killed every
      // camera and stopped the bridge auto-starting on next launch. Keep the
      // existing token (only reassigned on success above) and let a definitive
      // 401 on a real API call be what forces re-auth.
      console.error("[Auth] Refresh failed (best-effort, keeping current token):", err.message || err);
      return config.bambuTokens.accessToken;
    }
  }
  return config.bambuTokens.accessToken;
}

// ─── Network scan + match ────────────────────────────────

async function discoverPrinters() {
  const token = await getAccessToken();
  if (!token) throw new Error("Not logged in");

  // Fetch cloud printers
  scanProgress = { message: "Fetching printer list from Bambu Cloud...", progress: 0 };
  const cloudDevices = await bambuCloud.fetchPrinters(token);
  if (!cloudDevices.length) {
    scanProgress = { message: "No printers found on your Bambu account", progress: 1 };
    return [];
  }

  // Scan network and match
  const matched = await scanAndMatch(cloudDevices, (event) => {
    scanProgress = { message: event.message, progress: event.progress || 0 };
  });

  config.printers = matched;
  saveConfig();
  scanProgress = null;

  // If this was a re-scan while the bridge is live, rebuild it from the new
  // device list. Running camera closures and MQTT clients captured the OLD
  // ip/accessCode, so without a rebuild a printer whose LAN IP changed keeps
  // streaming (black) from its stale address, its control MQTT stays pinned to
  // the old IP, and printers dropped from the scan leak their MQTT client.
  // stopBridge tears down cameras + MQTT + demand cleanly; startBridge
  // reconnects everything from config.printers.
  if (bridgeRunning) {
    stopBridge();
    await startBridge();
  }

  return matched;
}

// ─── Camera management ───────────────────────────────────

// Per-printer reconnect tracking (failure counts, exponential backoff, circuit
// breaker) lives in ./cameraRetry.js — imported at the top of this file.

function startCamera(printer) {
  if (activeStreams.has(printer.devId)) return;

  // Skip if circuit breaker tripped — user must re-scan to clear it.
  if (isSuspended(printer.devId)) return;

  console.log(
    `[Camera] Starting ${printer.name} (${printer.ip}, ${printer.protocol || "jpeg"})`
  );
  streamStates.set(printer.devId, "connecting");

  // Newer models (X1 / H2 family / P2S) stream RTSPS on port 322 instead of
  // the port-6000 JPEG protocol — the scanner tags each match with `protocol`.
  // Printers matched by older bridge versions have no protocol field → jpeg.
  const createStream = printer.protocol === "rtsp" ? createRtspCameraStream : createCameraStream;

  // Reserve the slot with a placeholder BEFORE createStream. If construction
  // emits an error synchronously (e.g. an EMFILE from tls.connect), its
  // onStateChange runs activeStreams.delete first; installing the real stream
  // afterward would pin a dead stream and block the backoff retry. Only install
  // if the placeholder is still present.
  const placeholder = { stop() {} };
  activeStreams.set(printer.devId, placeholder);

  const stream = createStream({
    ip: printer.ip,
    accessCode: printer.accessCode,
    onFrame: (jpeg) => {
      // First successful frame after failures — reset the failure counter
      // (delete on a missing key is a no-op, so no has() guard needed).
      clearFailures(printer.devId);
      if (wsClient) wsClient.sendFrame(printer.devId, jpeg);
    },
    onStateChange: (state, msg) => {
      // Suppress repeat error logs after the first few — they're identical
      const isRepeatError =
        (state === "error" || state === "disconnected") && getFailureCount(printer.devId) > 2;
      if (!isRepeatError) {
        console.log(`[Camera] ${printer.name}: ${state}${msg ? ` — ${msg}` : ""}`);
      }
      streamStates.set(printer.devId, state);

      if (state === "error" || state === "authFailed" || state === "disconnected") {
        activeStreams.delete(printer.devId);
        const failInfo = recordFailure(printer.devId, state);

        if (failInfo.suspended) {
          if (failInfo.suspendedReason === "auth") {
            console.log(`[Camera] ${printer.name}: AUTH FAILED — won't retry. Re-scan to update access code.`);
          } else {
            console.log(`[Camera] ${printer.name}: stopped retrying after ${failInfo.count} failures. Re-scan to retry.`);
          }
          streamStates.set(printer.devId, "suspended");
          return;
        }

        // Auto-reconnect with exponential backoff
        if (demandedPrinters.has(printer.devId)) {
          const delay = getRetryDelay(printer.devId);
          if (failInfo.count <= 3) {
            console.log(`[Camera] ${printer.name}: retry in ${Math.round(delay / 1000)}s (attempt ${failInfo.count})`);
          }
          setTimeout(() => {
            if (demandedPrinters.has(printer.devId) && !activeStreams.has(printer.devId)) {
              startCamera(printer);
            }
          }, delay);
        }
      }
    },
  });

  if (activeStreams.get(printer.devId) === placeholder) {
    activeStreams.set(printer.devId, stream);
  } else {
    // A synchronous error already cleared the slot and scheduled a retry — drop
    // this now-dead stream instead of pinning it.
    try { stream.stop(); } catch {}
  }
}

function stopCamera(devId) {
  const stream = activeStreams.get(devId);
  if (stream) { stream.stop(); activeStreams.delete(devId); }
  streamStates.set(devId, "idle");
}

function stopAllCameras() {
  for (const [id] of activeStreams) stopCamera(id);
}

// ─── IP camera bindings (ONVIF / HTTP snapshot) ──────────

function findCameraBoundTo(printerId) {
  return config.cameras.find((c) => c.boundPrinterId === printerId) || null;
}

function startIpCamera(camera, printerId) {
  if (cameraStreams.has(camera.id)) return;
  console.log(`[IPCam] Starting ${camera.name} → ${printerId}`);
  cameraStreamStates.set(camera.id, "connecting");

  const puller = createSnapshotPuller({
    snapshotUrl: camera.snapshotUrl,
    username: camera.username,
    password: camera.password,
    intervalMs: camera.intervalMs || 1000,
    onFrame: (jpeg) => {
      // Reuse the existing frame pipeline — relay to the bound printer's devId
      // so the app shows it in the existing camera viewer with no changes.
      if (wsClient) wsClient.sendFrame(printerId, jpeg);
    },
    onStateChange: (state, msg) => {
      cameraStreamStates.set(camera.id, state);
      if (state === "connected") {
        console.log(`[IPCam] ${camera.name}: connected`);
      } else if (state === "authFailed") {
        console.log(`[IPCam] ${camera.name}: AUTH FAILED — won't retry. Update credentials.`);
        cameraStreams.delete(camera.id);
      } else if (state === "error") {
        // Single-line log; the puller does its own backoff
        console.log(`[IPCam] ${camera.name}: ${msg || "error"}`);
      }
    },
  });

  cameraStreams.set(camera.id, puller);
}

function stopIpCamera(cameraId) {
  const puller = cameraStreams.get(cameraId);
  if (puller) { puller.stop(); cameraStreams.delete(cameraId); }
  cameraStreamStates.set(cameraId, "idle");
}

function stopAllIpCameras() {
  for (const [id] of cameraStreams) stopIpCamera(id);
}

function handleDemandUpdate(printerIds) {
  const newDemand = new Set(printerIds);

  // Only log when the set actually changes — avoid log spam from duplicate updates.
  const changed =
    newDemand.size !== demandedPrinters.size ||
    [...newDemand].some((id) => !demandedPrinters.has(id));
  if (changed) {
    console.log(`[Bridge] Demand: ${printerIds.length ? printerIds.join(", ") : "(none)"}`);
  }

  // Reassign BEFORE the stop loop so recordFailure's demandedPrinters.has()
  // check is already false for a printer we're un-demanding — a synchronous
  // 'disconnected' emitted during stopCamera teardown then can't schedule a
  // spurious reconnect. Both loops key off the captured old set.
  const oldDemand = demandedPrinters;
  demandedPrinters = newDemand;

  for (const id of newDemand) {
    if (!oldDemand.has(id)) {
      // If an IP camera is bound to this printer, prefer it over the Bambu cam.
      // The bound camera relays frames using the printer's devId, so the app
      // sees them through the existing pipeline with no protocol changes.
      const ipCam = findCameraBoundTo(id);
      if (ipCam) {
        startIpCamera(ipCam, id);
      } else {
        const printer = config.printers.find((p) => p.devId === id);
        if (printer) startCamera(printer);
      }
    }
  }
  for (const id of oldDemand) {
    if (!newDemand.has(id)) {
      stopCamera(id);
      const ipCam = findCameraBoundTo(id);
      if (ipCam) stopIpCamera(ipCam.id);
    }
  }
}

// ─── Bridge start/stop ───────────────────────────────────

async function startBridge() {
  if (bridgeRunning) return;
  const token = await getAccessToken();
  if (!token) {
    throw new Error("Not logged in");
  }
  if (!config.printers.length) {
    throw new Error("No printers discovered — run scan first");
  }

  bridgeRunning = true;
  console.log(`[Bridge] Starting — ${config.printers.length} printers, connecting to ${DEFAULT_SERVER_URL}`);

  // Connect local MQTT for all printers (needed for control commands)
  for (const printer of config.printers) {
    mqttControl.connect(printer.devId, printer.ip, printer.accessCode);
  }

  wsClient = new BridgeWsClient({
    serverUrl: DEFAULT_SERVER_URL,
    bambuToken: token,
    onDemandUpdate: handleDemandUpdate,
    onStateChange: (state) => {
      wsState = state;
      console.log(`[Bridge] Server: ${state}`);
    },
    onCommand: (msg) => {
      const { devId, action, params, requestId } = msg;
      console.log(`[Bridge] Command: ${action} → ${devId}`);
      const success = mqttControl.executeCommand(devId, action, params || {});
      if (wsClient) wsClient.sendCommandResult(requestId, success, success ? null : "MQTT not connected");
      console.log(`[Bridge] Command ${action} → ${devId}: ${success ? "sent" : "failed"}`);
    },
  });
  wsClient.connect();
}

function stopBridge() {
  bridgeRunning = false;
  stopAllCameras();
  stopAllIpCameras();
  mqttControl.disconnectAll();
  demandedPrinters = new Set();
  if (wsClient) { wsClient.stop(); wsClient = null; }
  wsState = "disconnected";
  console.log("[Bridge] Stopped");
}

// ─── Web UI ──────────────────────────────────────────────

function getStatus() {
  return {
    loggedIn: !!config.bambuTokens,
    loginPending: loginPending ? { email: loginPending.email } : null,
    bridgeRunning,
    serverConnection: wsState,
    localIp: getLocalIp(),
    scanning: !!scanProgress,
    scanProgress,
    printers: config.printers.map((p) => ({
      devId: p.devId,
      name: p.name,
      ip: p.ip,
      streamState: streamStates.get(p.devId) || "idle",
      demanded: demandedPrinters.has(p.devId),
      boundCameraId: (findCameraBoundTo(p.devId) || {}).id || null,
    })),
    cameras: config.cameras.map((c) => ({
      id: c.id,
      name: c.name,
      brand: c.brand || null,
      model: c.model || null,
      ip: c.ip || null,
      snapshotUrl: c.snapshotUrl,
      hasCredentials: !!(c.username || c.password),
      boundPrinterId: c.boundPrinterId || null,
      streamState: cameraStreamStates.get(c.id) || "idle",
    })),
    cameraScan: cameraScanState,
  };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 10000) reject(new Error("Too large")); });
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON")); } });
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const UI_HTML = fs.readFileSync(path.join(__dirname, "ui.html"), "utf8");

// ─── HTTP Server ─────────────────────────────────────────

function startWebUI() {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(UI_HTML);
        return;
      }

      if (req.method === "GET" && req.url === "/api/status") {
        return sendJson(res, getStatus());
      }

      if (req.method === "POST" && req.url === "/api/login") {
        const { email, password } = await parseBody(req);
        try {
          const result = await bambuCloud.login(email, password);
          if (result.needsVerification) {
            loginPending = { email };
            return sendJson(res, { ok: true, needsVerification: true });
          }
          config.bambuTokens = result.tokens;
          loginPending = null;
          saveConfig();
          return sendJson(res, { ok: true });
        } catch (err) {
          return sendJson(res, { ok: false, error: err.message || "Login failed" }, 400);
        }
      }

      if (req.method === "POST" && req.url === "/api/verify") {
        const { email, code } = await parseBody(req);
        try {
          config.bambuTokens = await bambuCloud.verifyCode(email, code);
          loginPending = null;
          saveConfig();
          return sendJson(res, { ok: true });
        } catch (err) {
          return sendJson(res, { ok: false, error: err.message || "Verification failed" }, 400);
        }
      }

      if (req.method === "POST" && req.url === "/api/logout") {
        config.bambuTokens = null;
        config.printers = [];
        loginPending = null;
        stopBridge();
        saveConfig();
        return sendJson(res, { ok: true });
      }

      if (req.method === "POST" && req.url === "/api/scan") {
        // Re-scanning means the user is trying to fix something — clear suspended
        // cameras so they get a fresh chance after the new config is saved.
        clearAllFailures();
        // Run scan in background
        discoverPrinters().catch((err) => {
          console.error("[Scan] Error:", err.message || err);
          scanProgress = { message: `Error: ${err.message || err}`, progress: 0 };
          setTimeout(() => { scanProgress = null; }, 5000);
        });
        return sendJson(res, { ok: true });
      }

      if (req.method === "POST" && req.url === "/api/bridge/start") {
        try {
          await startBridge();
          return sendJson(res, { ok: true });
        } catch (err) {
          return sendJson(res, { ok: false, error: err.message }, 400);
        }
      }

      if (req.method === "POST" && req.url === "/api/bridge/stop") {
        stopBridge();
        return sendJson(res, { ok: true });
      }

      // ─── IP camera routes ────────────────────────────

      // Run ONVIF discovery — returns immediately, results polled via /api/status
      if (req.method === "POST" && req.url === "/api/cameras/scan") {
        if (cameraScanState?.running) return sendJson(res, { ok: true });
        cameraScanState = { running: true, progress: 0, found: [] };
        onvif.discover((cam) => {
          cameraScanState.found.push(cam);
          console.log(`[ONVIF] Found ${cam.brand || "?"} ${cam.model || ""} at ${cam.ip}`);
        }).then((all) => {
          cameraScanState = { running: false, progress: 1, found: all };
          console.log(`[ONVIF] Scan done — ${all.length} camera(s) found`);
          // Auto-clear after 60s so a stale scan doesn't sit in the UI forever
          setTimeout(() => { if (!cameraScanState?.running) cameraScanState = null; }, 60000);
        }).catch((err) => {
          console.error("[ONVIF] Scan error:", err.message);
          cameraScanState = { running: false, progress: 1, found: [], error: err.message };
        });
        return sendJson(res, { ok: true });
      }

      // Add a camera (manual or from a discovery result)
      if (req.method === "POST" && req.url === "/api/cameras") {
        const body = await parseBody(req);
        const { name, snapshotUrl, username, password, brand, model, ip, intervalMs } = body || {};
        if (!name || !snapshotUrl) {
          return sendJson(res, { ok: false, error: "name and snapshotUrl are required" }, 400);
        }
        const cam = {
          id: crypto.randomUUID(),
          name: String(name).slice(0, 80),
          snapshotUrl: String(snapshotUrl),
          username: username || undefined,
          password: password || undefined,
          brand: brand || undefined,
          model: model || undefined,
          ip: ip || undefined,
          intervalMs: intervalMs ? Math.max(250, Number(intervalMs)) : undefined,
          boundPrinterId: null,
          addedAt: new Date().toISOString(),
        };
        config.cameras.push(cam);
        saveConfig();
        return sendJson(res, { ok: true, camera: { ...cam, password: cam.password ? "***" : undefined } });
      }

      // Test a snapshot URL without saving — useful for the UI before commit
      if (req.method === "POST" && req.url === "/api/cameras/test") {
        const { snapshotUrl, username, password } = await parseBody(req);
        if (!snapshotUrl) return sendJson(res, { ok: false, error: "snapshotUrl required" }, 400);
        try {
          const t0 = Date.now();
          const jpeg = await fetchSnapshot(snapshotUrl, username, password);
          return sendJson(res, { ok: true, bytes: jpeg.length, took_ms: Date.now() - t0 });
        } catch (err) {
          return sendJson(res, { ok: false, error: err.message }, 400);
        }
      }

      // Camera-specific routes: /api/cameras/:id/(bind|unbind|delete)
      const camRoute = req.url.match(/^\/api\/cameras\/([^/]+)(?:\/(\w+))?$/);
      if (camRoute) {
        const cameraId = camRoute[1];
        const action = camRoute[2] || null;
        const cam = config.cameras.find((c) => c.id === cameraId);
        if (!cam) return sendJson(res, { ok: false, error: "Camera not found" }, 404);

        if (req.method === "POST" && action === "bind") {
          const { printerId } = await parseBody(req);
          if (!printerId) return sendJson(res, { ok: false, error: "printerId required" }, 400);
          // Unbind any other camera from that printer first — one-cam-per-printer
          for (const c of config.cameras) {
            if (c.boundPrinterId === printerId && c.id !== cameraId) {
              c.boundPrinterId = null;
              stopIpCamera(c.id);
            }
          }
          cam.boundPrinterId = printerId;
          saveConfig();
          // If that printer is currently being demanded, swap from Bambu cam to IP cam now
          if (demandedPrinters.has(printerId)) {
            stopCamera(printerId);
            startIpCamera(cam, printerId);
          }
          return sendJson(res, { ok: true });
        }

        if (req.method === "POST" && action === "unbind") {
          const printerId = cam.boundPrinterId;
          cam.boundPrinterId = null;
          saveConfig();
          stopIpCamera(cam.id);
          // If printer is still demanded, fall back to its Bambu camera (if any)
          if (printerId && demandedPrinters.has(printerId)) {
            const printer = config.printers.find((p) => p.devId === printerId);
            if (printer) startCamera(printer);
          }
          return sendJson(res, { ok: true });
        }

        if (req.method === "DELETE" && !action) {
          stopIpCamera(cam.id);
          const printerId = cam.boundPrinterId;
          config.cameras = config.cameras.filter((c) => c.id !== cameraId);
          saveConfig();
          if (printerId && demandedPrinters.has(printerId)) {
            const printer = config.printers.find((p) => p.devId === printerId);
            if (printer) startCamera(printer);
          }
          return sendJson(res, { ok: true });
        }
      }

      res.writeHead(404);
      res.end("Not Found");
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
  });

  return new Promise((resolve) => {
    server.listen(UI_PORT, async () => {
      console.log(`\n  BambuBridge v1.0.0`);
      console.log(`  Open http://localhost:${UI_PORT} in your browser\n`);
      resolve(server);
      // Auto-open browser (only when running standalone, never in Electron)
      const isElectron = !!process.versions.electron;
      if (!isElectron && require.main === module) {
        try {
          const open = (await import("open")).default;
          open(`http://localhost:${UI_PORT}`);
        } catch {}
      }
    });
  });
}

/**
 * Start the bridge server. Returns a promise that resolves when the HTTP
 * server is listening. Used by both standalone mode and Electron.
 */
async function startServer() {
  loadConfig();
  const server = await startWebUI();

  // Auto-start bridge if already configured
  if (config.bambuTokens && config.printers.length) {
    startBridge().catch((err) => console.error("[AutoStart]", err.message));
  }

  return server;
}

module.exports = { startServer, startWebUI, stopBridge, UI_PORT };

// ─── Main (standalone mode) ─────────────────────────────

if (require.main === module) {
  startServer();

  process.on("SIGINT", () => {
    console.log("\n[Bridge] Shutting down...");
    stopBridge();
    process.exit(0);
  });
}
