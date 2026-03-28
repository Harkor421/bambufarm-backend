const http2 = require("http2");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const log = require("../utils/logger");

const APNS_KEY_PATH = process.env.APNS_KEY_PATH;
const APNS_KEY_ID = process.env.APNS_KEY_ID;
const APNS_TEAM_ID = process.env.APNS_TEAM_ID;
const APNS_KEY_CONTENTS = process.env.APNS_KEY_CONTENTS; // fallback: raw p8 key as env var
const BUNDLE_ID = "com.harkor421.bambufarm";
const APNS_TOPIC = `${BUNDLE_ID}.push-type.liveactivity`;
const APNS_HOST_PROD = "api.push.apple.com";
const APNS_HOST_SANDBOX = "api.sandbox.push.apple.com";
const APNS_HOST = process.env.APNS_HOST || APNS_HOST_PROD;

let apnsKey = null;
let cachedJWT = null;
let jwtIssuedAt = 0;
let h2Client = null;
let h2ClientSandbox = null;

function isConfigured() {
  return !!((APNS_KEY_PATH || APNS_KEY_CONTENTS) && APNS_KEY_ID && APNS_TEAM_ID);
}

function logConfig() {
  log.info(`[APNS] configured=${isConfigured()} host=${APNS_HOST} keyId=${APNS_KEY_ID || "MISSING"} teamId=${APNS_TEAM_ID || "MISSING"} keySource=${APNS_KEY_CONTENTS ? "env" : APNS_KEY_PATH ? "file" : "NONE"}`);
}

function loadKey() {
  if (apnsKey) return apnsKey;
  // Prefer env var contents (for Railway/cloud), fall back to file path
  if (APNS_KEY_CONTENTS) {
    apnsKey = APNS_KEY_CONTENTS;
    return apnsKey;
  }
  if (!APNS_KEY_PATH) return null;
  try {
    apnsKey = fs.readFileSync(APNS_KEY_PATH, "utf8");
    return apnsKey;
  } catch (err) {
    log.error(`[APNS] Failed to read p8 key: ${err.message}`);
    return null;
  }
}

function getJWT() {
  const now = Math.floor(Date.now() / 1000);
  // Refresh JWT every 50 minutes (Apple allows 60 min max)
  if (cachedJWT && now - jwtIssuedAt < 3000) return cachedJWT;

  const key = loadKey();
  if (!key) return null;

  cachedJWT = jwt.sign({ iss: APNS_TEAM_ID, iat: now }, key, {
    algorithm: "ES256",
    header: { alg: "ES256", kid: APNS_KEY_ID },
  });
  jwtIssuedAt = now;
  return cachedJWT;
}

function getClient(sandbox = false) {
  if (sandbox) {
    if (h2ClientSandbox && !h2ClientSandbox.closed && !h2ClientSandbox.destroyed) return h2ClientSandbox;
    h2ClientSandbox = http2.connect(`https://${APNS_HOST_SANDBOX}`);
    h2ClientSandbox.on("error", (err) => { log.error(`[APNS] Sandbox HTTP/2 error: ${err.message}`); h2ClientSandbox = null; });
    h2ClientSandbox.on("close", () => { h2ClientSandbox = null; });
    return h2ClientSandbox;
  }
  if (h2Client && !h2Client.closed && !h2Client.destroyed) return h2Client;
  h2Client = http2.connect(`https://${APNS_HOST}`);
  h2Client.on("error", (err) => { log.error(`[APNS] HTTP/2 error: ${err.message}`); h2Client = null; });
  h2Client.on("close", () => { h2Client = null; });
  return h2Client;
}

/**
 * Send a raw APNs Live Activity push.
 * @param {string} deviceToken - hex-encoded push token
 * @param {object} payload - APNs JSON payload
 * @param {number} priority - 5 (may delay) or 10 (immediate)
 * @returns {Promise<{success: boolean, status: number, reason?: string}>}
 */
function sendAPNsRaw(deviceToken, payload, priority = 10, sandbox = false) {
  return new Promise((resolve) => {
    const token = getJWT();
    if (!token) {
      resolve({ success: false, status: 0, reason: "no-jwt" });
      return;
    }

    let client;
    try {
      client = getClient(sandbox);
    } catch (err) {
      resolve({ success: false, status: 0, reason: err.message });
      return;
    }

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${token}`,
      "apns-push-type": "liveactivity",
      "apns-topic": APNS_TOPIC,
      "apns-priority": String(priority),
      "apns-expiration": "0",
    });

    let responseData = "";
    let statusCode = 0;

    req.on("response", (headers) => {
      statusCode = headers[":status"];
    });
    req.on("data", (chunk) => {
      responseData += chunk;
    });
    req.on("end", () => {
      const success = statusCode === 200;
      let reason = null;
      if (responseData) {
        try {
          reason = JSON.parse(responseData);
        } catch {
          reason = responseData;
        }
      }
      if (!success) {
        log.warn(`[APNS] Push failed: status=${statusCode} reason=${JSON.stringify(reason)}`);
      }
      resolve({ success, status: statusCode, reason });
    });
    req.on("error", (err) => {
      log.error(`[APNS] Request error: ${err.message}`);
      resolve({ success: false, status: 0, reason: err.message });
    });

    req.write(JSON.stringify(payload));
    req.end();
  });
}

/**
 * Send APNs push — tries production first, falls back to sandbox on BadDeviceToken.
 * This handles both dev and production builds transparently.
 */
async function sendAPNs(deviceToken, payload, priority = 10) {
  const result = await sendAPNsRaw(deviceToken, payload, priority, false);
  // If production returns BadDeviceToken, the token might be from a dev build — try sandbox
  if (result.status === 400 && result.reason?.reason === "BadDeviceToken") {
    log.info(`[APNS] Production rejected token, trying sandbox...`);
    return sendAPNsRaw(deviceToken, payload, priority, true);
  }
  return result;
}

/**
 * Start a Live Activity via push-to-start (iOS 17.2+).
 * @param {string} pushToStartToken - hex token from pushToStartTokenUpdates
 * @param {object} attributes - { printerId, printerName }
 * @param {object} contentState - { jobTitle, progress, startTime, endTime, status }
 * @param {object} [alert] - optional { title, body }
 */
async function sendLiveActivityStart(pushToStartToken, attributes, contentState, alert) {
  if (!isConfigured()) return null;

  const payload = {
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event: "start",
      "content-state": contentState,
      "attributes-type": "PrintActivityAttributes",
      attributes,
      alert: alert || {
        title: `${attributes.printerName} started printing`,
        body: contentState.jobTitle || "Print Job",
      },
    },
  };

  return sendAPNs(pushToStartToken, payload, 10);
}

/**
 * Update an existing Live Activity.
 * @param {string} activityUpdateToken - hex token from activity.pushTokenUpdates
 * @param {object} contentState - { jobTitle, progress, startTime, endTime, status }
 */
async function sendLiveActivityUpdate(activityUpdateToken, contentState, priority = 5) {
  if (!isConfigured()) return null;

  const payload = {
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event: "update",
      "content-state": contentState,
    },
  };

  return sendAPNs(activityUpdateToken, payload, priority);
}

/**
 * End a Live Activity via push.
 * @param {string} activityUpdateToken - hex token
 * @param {object} finalContentState - final state to display
 * @param {number} [dismissAfterSec=300] - seconds to keep on lock screen after end
 */
async function sendLiveActivityEnd(activityUpdateToken, finalContentState, dismissAfterSec = 300) {
  if (!isConfigured()) return null;

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aps: {
      timestamp: now,
      event: "end",
      "content-state": finalContentState,
      "dismissal-date": now + dismissAfterSec,
    },
  };

  return sendAPNs(activityUpdateToken, payload, 10);
}

module.exports = {
  isConfigured,
  logConfig,
  sendLiveActivityStart,
  sendLiveActivityUpdate,
  sendLiveActivityEnd,
};
