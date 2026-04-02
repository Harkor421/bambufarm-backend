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
const { BridgeWsClient } = require("./wsClient");
const { PrinterMqttControl } = require("./mqttControl");

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
      console.error("[Auth] Refresh failed:", err.message || err);
      config.bambuTokens = null;
      saveConfig();
      return null;
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
  return matched;
}

// ─── Camera management ───────────────────────────────────

function startCamera(printer) {
  if (activeStreams.has(printer.devId)) return;

  console.log(`[Camera] Starting ${printer.name} (${printer.ip})`);
  streamStates.set(printer.devId, "connecting");

  const stream = createCameraStream({
    ip: printer.ip,
    accessCode: printer.accessCode,
    onFrame: (jpeg) => {
      if (wsClient) wsClient.sendFrame(printer.devId, jpeg);
    },
    onStateChange: (state, msg) => {
      console.log(`[Camera] ${printer.name}: ${state}${msg ? ` — ${msg}` : ""}`);
      streamStates.set(printer.devId, state);

      if (state === "error" || state === "authFailed" || state === "disconnected") {
        activeStreams.delete(printer.devId);
        // Auto-reconnect if still demanded
        if (demandedPrinters.has(printer.devId)) {
          setTimeout(() => {
            if (demandedPrinters.has(printer.devId) && !activeStreams.has(printer.devId)) {
              startCamera(printer);
            }
          }, 5000);
        }
      }
    },
  });

  activeStreams.set(printer.devId, stream);
}

function stopCamera(devId) {
  const stream = activeStreams.get(devId);
  if (stream) { stream.stop(); activeStreams.delete(devId); }
  streamStates.set(devId, "idle");
}

function stopAllCameras() {
  for (const [id] of activeStreams) stopCamera(id);
}

function handleDemandUpdate(printerIds) {
  const newDemand = new Set(printerIds);
  console.log(`[Bridge] Demand: ${printerIds.length ? printerIds.join(", ") : "(none)"}`);

  for (const id of newDemand) {
    if (!demandedPrinters.has(id)) {
      const printer = config.printers.find((p) => p.devId === id);
      if (printer) startCamera(printer);
    }
  }
  for (const id of demandedPrinters) {
    if (!newDemand.has(id)) stopCamera(id);
  }
  demandedPrinters = newDemand;
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
    })),
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

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>BambuBridge</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh;-webkit-app-region:drag}
body *{-webkit-app-region:no-drag}
.titlebar{-webkit-app-region:drag;height:28px;position:fixed;top:0;left:0;right:0;z-index:100}
.container{max-width:560px;margin:0 auto;padding:40px 20px 24px}
.header{display:flex;align-items:center;gap:12px;margin-bottom:4px;-webkit-app-region:drag;cursor:default}
.header-logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#26FF9A,#1a9d62);display:flex;align-items:center;justify-content:center}
.header-logo svg{width:20px;height:20px}
h1{color:#26FF9A;font-size:22px;font-weight:700;letter-spacing:-.3px}
.sub{color:#555;font-size:13px;margin-bottom:24px}
.card{background:#131313;border:1px solid #1e1e1e;border-radius:16px;padding:22px;margin-bottom:14px;position:relative;overflow:hidden}
.card-accent{position:absolute;top:0;left:0;right:0;height:3px;border-radius:2px 2px 0 0;opacity:.7}
.card h2{font-size:12px;color:#666;margin-bottom:14px;text-transform:uppercase;letter-spacing:.8px;font-weight:600}
label{display:block;font-size:13px;color:#777;margin-bottom:5px}
input{width:100%;padding:11px 14px;border-radius:10px;border:1px solid #252525;background:#0e0e0e;color:#e0e0e0;font-size:14px;margin-bottom:10px;outline:none;transition:border .2s}
input:focus{border-color:#26FF9A44}
input::placeholder{color:#444}
input[type=password]{font-family:monospace;letter-spacing:1px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 24px;border-radius:10px;border:none;font-weight:600;font-size:14px;cursor:pointer;transition:all .2s ease;width:100%}
.btn:active{transform:scale(.98)}
.btn-primary{background:#26FF9A18;color:#26FF9A;border:1px solid #26FF9A33}
.btn-primary:hover{background:#26FF9A28;border-color:#26FF9A55}
.btn-danger{background:#ff4d4d12;color:#ff4d4d;border:1px solid #ff4d4d28}
.btn-danger:hover{background:#ff4d4d22;border-color:#ff4d4d44}
.btn-secondary{background:#ffffff06;color:#999;border:1px solid #2a2a2a}
.btn-secondary:hover{background:#ffffff0c;color:#bbb}
.btn:disabled{opacity:.35;cursor:default;transform:none}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;flex-shrink:0}
.dot-green{background:#26FF9A;box-shadow:0 0 6px #26FF9A66}
.dot-yellow{background:#FFB020;box-shadow:0 0 6px #FFB02066}
.dot-red{background:#FF4D4D;box-shadow:0 0 6px #FF4D4D66}
.dot-gray{background:#333}
.printer{display:flex;align-items:center;padding:14px 0;border-bottom:1px solid #1a1a1a}
.printer:last-child{border-bottom:none}
.printer-icon{width:42px;height:42px;border-radius:12px;background:#26FF9A0a;border:1px solid #26FF9A15;display:flex;align-items:center;justify-content:center;margin-right:14px;font-size:20px;flex-shrink:0}
.printer-info{flex:1;min-width:0}
.printer-name{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.printer-detail{color:#555;font-size:11px;font-family:monospace;margin-top:3px}
.printer-state{font-size:11px;margin-top:4px;display:flex;align-items:center}
.progress-bar{width:100%;height:3px;border-radius:2px;background:#1a1a1a;overflow:hidden;margin-top:12px}
.progress-fill{height:100%;background:linear-gradient(90deg,#26FF9A,#1a9d62);border-radius:2px;transition:width .3s}
.status-row{display:flex;align-items:center;font-size:14px;margin-bottom:10px}
.hidden{display:none!important}
.big-status{text-align:center;padding:28px 0}
.big-status .icon{font-size:44px;margin-bottom:14px;opacity:.8}
.big-status p{color:#777;font-size:13px;line-height:1.6}
.help-btn{position:fixed;bottom:16px;right:16px;width:30px;height:30px;border-radius:50%;border:1px solid #2a2a2a;background:#131313;color:#555;font-size:13px;cursor:pointer;z-index:50;-webkit-app-region:no-drag;display:flex;align-items:center;justify-content:center;transition:all .2s}
.help-btn:hover{border-color:#26FF9A44;color:#26FF9A}
.version{text-align:center;color:#2a2a2a;font-size:11px;margin-top:20px;letter-spacing:.3px}

/* ─── Tutorial overlay ─── */
.tut-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.88);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:200;display:flex;align-items:center;justify-content:center;-webkit-app-region:no-drag;animation:fadeIn .3s}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.tut-card{background:#131313;border:1px solid #26FF9A22;border-radius:20px;max-width:440px;width:88%;padding:40px 32px 28px;text-align:center;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.tut-card h2{color:#e0e0e0;font-size:20px;margin-bottom:10px;font-weight:600}
.tut-card p{color:#888;font-size:14px;line-height:1.7;margin-bottom:22px}
.tut-card p strong{color:#ccc;font-weight:600}
.tut-icon{font-size:44px;margin-bottom:18px}
.tut-dots{display:flex;justify-content:center;gap:8px;margin-bottom:22px}
.tut-dots span{width:8px;height:8px;border-radius:50%;background:#252525;transition:all .3s}
.tut-dots span.active{background:#26FF9A;box-shadow:0 0 8px #26FF9A44}
.tut-nav{display:flex;gap:8px;justify-content:center}
.tut-nav .btn{width:auto;padding:10px 24px;min-width:100px}
.tut-skip{position:absolute;top:14px;right:18px;color:#444;font-size:12px;cursor:pointer;border:none;background:none;padding:4px 8px;transition:color .2s}
.tut-skip:hover{color:#888}
.tut-badge{display:inline-block;font-size:11px;color:#26FF9A;background:#26FF9A15;border:1px solid #26FF9A22;border-radius:20px;padding:3px 12px;margin-bottom:18px;letter-spacing:.3px}

/* ─── Important notes callout ─── */
.callout{background:#FFB02008;border:1px solid #FFB02022;border-radius:10px;padding:14px 16px;margin-bottom:14px;font-size:13px;color:#bbb;line-height:1.6}
.callout strong{color:#FFB020;font-weight:600}
.callout ul{margin:6px 0 0 16px;color:#999}
.callout ul li{margin-bottom:2px}
</style>
</head>
<body>

<!-- Tutorial overlay -->
<div id="tutorial" class="tut-overlay hidden">
<div class="tut-card">
<button class="tut-skip" onclick="closeTutorial()">Skip</button>
<div id="tutContent"></div>
<div class="tut-dots" id="tutDots"></div>
<div class="tut-nav">
<button class="btn btn-secondary" id="tutPrev" onclick="tutNav(-1)">Back</button>
<button class="btn btn-primary" id="tutNext" onclick="tutNav(1)">Next</button>
</div>
</div>
</div>

<div class="titlebar"></div>
<div class="container">

<!-- Header -->
<div class="header">
<div class="header-logo">
<svg viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
</div>
<h1>BambuBridge</h1>
</div>
<p class="sub">Camera bridge for your Bambu Lab printers</p>

<!-- Login -->
<div id="loginCard" class="card">
<h2>Account</h2>
<div id="loggedOut">
<label>Email</label>
<input id="email" type="email" placeholder="you@example.com" autocomplete="email">
<label>Password</label>
<input id="password" type="password" placeholder="Your Bambu Lab password" autocomplete="current-password">
<div id="tfaRow" class="hidden" style="margin-top:4px">
<label>Verification Code (check your email)</label>
<input id="tfaCode" placeholder="123456" autocomplete="one-time-code">
</div>
<button class="btn btn-primary" id="loginBtn" onclick="doLogin()">Log In</button>
<p id="loginError" style="color:#ff4d4d;font-size:12px;margin-top:8px"></p>
</div>
<div id="loggedIn" class="hidden">
<div class="status-row"><span class="dot dot-green"></span> Connected to Bambu Cloud</div>
<div style="display:flex;gap:8px;margin-top:10px">
<button class="btn btn-secondary" onclick="showTutorial()" style="flex:1">How it works</button>
<button class="btn btn-secondary" onclick="doLogout()" style="flex:1">Log Out</button>
</div>
</div>
</div>

<!-- Printers & Bridge -->
<div id="bridgeCard" class="card hidden">
<h2>Camera Bridge</h2>
<div id="bridgeContent"></div>
</div>

<p class="version">BambuBridge v1.0.0</p>
</div>

<!-- Help button (re-open tutorial) -->
<button class="help-btn" onclick="showTutorial()" title="How it works">?</button>

<script>
// ─── Tutorial ──────────────────────────────────────

const STEPS = [
  {
    badge: 'Welcome',
    icon: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#26FF9A" stroke-width="1.5" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    title: 'Welcome to BambuBridge',
    body: 'BambuBridge streams your Bambu Lab printer cameras to the <strong>BambuFarm</strong> cloud so you can monitor prints from anywhere &mdash; your phone, tablet, or any browser.'
  },
  {
    badge: 'Important',
    icon: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#FFB020" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
    title: 'Keep in Mind',
    body: '<strong>This app must run on a computer on the same WiFi / LAN as your printers.</strong> It connects directly to each printer\\'s camera over your local network.<br><br>Your printers must be <strong>powered on</strong> and connected to the network for the bridge to find them.'
  },
  {
    badge: 'Step 1',
    icon: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#26FF9A" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>',
    title: 'Log In',
    body: 'Sign in with your <strong>Bambu Lab account</strong> &mdash; the same one you use in Bambu Studio or Bambu Handy. This lets the bridge look up your registered printers and their access codes.'
  },
  {
    badge: 'Step 2',
    icon: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#26FF9A" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    title: 'Discover Printers',
    body: 'The bridge scans your local network for devices with the Bambu camera port open, then matches each IP to your cloud account. This takes about 15&ndash;30 seconds.'
  },
  {
    badge: 'Step 3',
    icon: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#26FF9A" stroke-width="1.5" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    title: 'Start the Bridge',
    body: 'Hit <strong>Start Bridge</strong> and you\\'re done! The bridge connects to BambuFarm and only streams cameras when someone is actively watching. You can close this window &mdash; it keeps running in your <strong>system tray</strong>.'
  }
];

let tutStep = 0;

function showTutorial() {
  document.getElementById('tutorial').classList.remove('hidden');
  tutStep = 0;
  renderTut();
}

function closeTutorial() {
  document.getElementById('tutorial').classList.add('hidden');
  localStorage.setItem('bb_tutorial_done', '1');
}

function renderTut() {
  const s = STEPS[tutStep];
  document.getElementById('tutContent').innerHTML =
    '<div class="tut-badge">' + s.badge + '</div>' +
    '<div class="tut-icon">' + s.icon + '</div>' +
    '<h2>' + s.title + '</h2>' +
    '<p>' + s.body + '</p>';

  let dots = '';
  for (let i = 0; i < STEPS.length; i++) {
    dots += '<span class="' + (i === tutStep ? 'active' : '') + '"></span>';
  }
  document.getElementById('tutDots').innerHTML = dots;

  document.getElementById('tutPrev').style.display = tutStep === 0 ? 'none' : '';
  document.getElementById('tutNext').textContent = tutStep === STEPS.length - 1 ? 'Get Started' : 'Next';
}

function tutNav(dir) {
  tutStep += dir;
  if (tutStep >= STEPS.length) { closeTutorial(); return; }
  if (tutStep < 0) tutStep = 0;
  renderTut();
}

if (!localStorage.getItem('bb_tutorial_done')) showTutorial();

// ─── App ───────────────────────────────────────────

let S = {};

async function poll() {
  try {
    const r = await fetch('/api/status');
    S = await r.json();
    render();
  } catch {}
}

function render() {
  const li = document.getElementById('loggedIn');
  const lo = document.getElementById('loggedOut');
  if (S.loggedIn) { li.classList.remove('hidden'); lo.classList.add('hidden'); }
  else { li.classList.add('hidden'); lo.classList.remove('hidden'); }

  if (S.loginPending) {
    document.getElementById('tfaRow').classList.remove('hidden');
    document.getElementById('loginBtn').textContent = 'Verify Code';
  }

  document.getElementById('bridgeCard').classList.toggle('hidden', !S.loggedIn);

  const bc = document.getElementById('bridgeContent');
  if (!bc) return;

  if (S.scanning && S.scanProgress) {
    bc.innerHTML = '<div class="big-status">' +
      '<div class="icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#26FF9A" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div>' +
      '<p>' + esc(S.scanProgress.message) + '</p>' +
      '<div class="progress-bar"><div class="progress-fill" style="width:'+Math.round((S.scanProgress.progress||0)*100)+'%"></div></div></div>';
    return;
  }

  let html = '';

  // Connection accent bar when running
  if (S.bridgeRunning) {
    const color = S.serverConnection === 'connected' ? '#26FF9A' : S.serverConnection === 'connecting' ? '#FFB020' : '#FF4D4D';
    html += '<div class="card-accent" style="background:'+color+'"></div>';
  }

  if (S.bridgeRunning) {
    const dc = S.serverConnection === 'connected' ? 'dot-green' : S.serverConnection === 'connecting' ? 'dot-yellow' : 'dot-red';
    const label = S.serverConnection === 'connected' ? 'Bridge connected' : S.serverConnection === 'connecting' ? 'Connecting...' : 'Disconnected';
    html += '<div class="status-row"><span class="dot '+dc+'"></span>' + label + '</div>';
    html += '<button class="btn btn-danger" onclick="toggleBridge()">Stop Bridge</button>';
  } else if (S.printers && S.printers.length > 0) {
    html += '<button class="btn btn-primary" onclick="toggleBridge()">Start Bridge</button>';
  }

  if (S.printers && S.printers.length > 0) {
    html += '<div style="margin-top:16px">';
    for (const p of S.printers) {
      const sc = p.streamState === 'connected' ? 'dot-green' : p.streamState === 'connecting' ? 'dot-yellow' : p.streamState === 'error' || p.streamState === 'authFailed' ? 'dot-red' : 'dot-gray';
      const stateLabel = p.streamState === 'connected' ? (p.demanded ? 'Streaming' : 'Connected') : p.streamState === 'connecting' ? 'Connecting...' : p.streamState === 'error' ? 'Error' : p.streamState === 'authFailed' ? 'Auth failed' : 'Idle';
      html += '<div class="printer">' +
        '<div class="printer-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#26FF9A" stroke-width="1.5" stroke-linecap="round"><rect x="6" y="2" width="12" height="8" rx="1"/><rect x="4" y="10" width="16" height="10" rx="1"/><line x1="8" y1="22" x2="8" y2="20"/><line x1="16" y1="22" x2="16" y2="20"/></svg></div>' +
        '<div class="printer-info">' +
          '<div class="printer-name">'+esc(p.name)+'</div>' +
          '<div class="printer-detail">'+esc(p.ip)+'</div>' +
          '<div class="printer-state"><span class="dot '+sc+'"></span>'+stateLabel+'</div>' +
        '</div></div>';
    }
    html += '</div>';
    html += '<button class="btn btn-secondary" style="margin-top:14px" onclick="rescan()">Re-scan Network</button>';
  } else {
    html += '<div class="big-status">' +
      '<div class="icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="1.5" stroke-linecap="round"><rect x="6" y="2" width="12" height="8" rx="1"/><rect x="4" y="10" width="16" height="10" rx="1"/><line x1="8" y1="22" x2="8" y2="20"/><line x1="16" y1="22" x2="16" y2="20"/></svg></div>' +
      '<p>No printers discovered yet.<br>Make sure your printers are on and connected.</p></div>';
    html += '<button class="btn btn-primary" onclick="rescan()">Discover Printers</button>';
  }

  bc.innerHTML = html;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

async function doLogin() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const code = document.getElementById('tfaCode').value.trim();
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';

  if (S.loginPending && code) {
    try {
      const r = await fetch('/api/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:S.loginPending.email, code}) });
      const d = await r.json();
      if (!d.ok) { errEl.textContent = d.error || 'Verification failed'; return; }
      poll();
    } catch(e) { errEl.textContent = e.message; }
    return;
  }

  if (!email || !password) { errEl.textContent = 'Enter email and password'; return; }
  try {
    document.getElementById('loginBtn').disabled = true;
    const r = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email, password}) });
    const d = await r.json();
    document.getElementById('loginBtn').disabled = false;
    if (d.needsVerification) {
      document.getElementById('tfaRow').classList.remove('hidden');
      document.getElementById('loginBtn').textContent = 'Verify Code';
      errEl.textContent = '';
    } else if (!d.ok) {
      errEl.textContent = d.error || 'Login failed';
    } else {
      poll();
    }
  } catch(e) { errEl.textContent = e.message; document.getElementById('loginBtn').disabled = false; }
}

async function doLogout() {
  await fetch('/api/logout', {method:'POST'});
  poll();
}

async function rescan() {
  await fetch('/api/scan', {method:'POST'});
  poll();
}

async function toggleBridge() {
  if (S.bridgeRunning) {
    await fetch('/api/bridge/stop', {method:'POST'});
  } else {
    await fetch('/api/bridge/start', {method:'POST'});
  }
  poll();
}

poll();
setInterval(poll, 2000);
</script>
</body>
</html>`;

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

module.exports = { startServer, startWebUI, UI_PORT };

// ─── Main (standalone mode) ─────────────────────────────

if (require.main === module) {
  startServer();

  process.on("SIGINT", () => {
    console.log("\n[Bridge] Shutting down...");
    stopBridge();
    process.exit(0);
  });
}
