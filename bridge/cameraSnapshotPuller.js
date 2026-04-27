/**
 * IP camera snapshot puller — fetches JPEG snapshots from an HTTP URL on a
 * loop and forwards them through the existing frame pipeline.
 *
 * Used for IP/security cameras the user binds to a printer. Supports HTTP
 * Basic auth via username/password. RTSP-only cameras (no HTTP snapshot
 * endpoint) are out of scope for v1 — they need ffmpeg transcoding.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const DEFAULT_INTERVAL_MS = 1000; // 1 fps default — keep server bandwidth honest
const REQUEST_TIMEOUT_MS = 5000;
const MAX_PAYLOAD = 8 * 1024 * 1024; // 8 MB hard cap per frame

function buildAuthHeader(username, password) {
  if (!username && !password) return null;
  const token = Buffer.from(`${username || ""}:${password || ""}`).toString("base64");
  return `Basic ${token}`;
}

function fetchSnapshot(snapshotUrl, username, password) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(snapshotUrl);
    } catch (err) {
      return reject(new Error(`Invalid URL: ${snapshotUrl}`));
    }
    const lib = url.protocol === "https:" ? https : http;
    const headers = {};
    const authHeader = buildAuthHeader(username, password);
    if (authHeader) headers["Authorization"] = authHeader;

    const req = lib.get(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        rejectUnauthorized: false, // most IP cams have self-signed certs
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const ct = (res.headers["content-type"] || "").toLowerCase();
        if (ct && !ct.includes("image/") && !ct.includes("application/octet-stream")) {
          res.resume();
          return reject(new Error(`Unexpected content-type: ${ct}`));
        }
        const chunks = [];
        let total = 0;
        res.on("data", (c) => {
          total += c.length;
          if (total > MAX_PAYLOAD) {
            req.destroy();
            return reject(new Error(`Payload too large (>${MAX_PAYLOAD} bytes)`));
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          // Sanity check: JPEG starts with FF D8 FF
          if (buf.length < 3 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
            return reject(new Error("Response is not a JPEG"));
          }
          resolve(buf);
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.on("error", reject);
  });
}

/**
 * Start polling a snapshot URL and emit JPEG frames.
 *
 * @param {Object} opts
 * @param {string} opts.snapshotUrl
 * @param {string} [opts.username]
 * @param {string} [opts.password]
 * @param {number} [opts.intervalMs] - delay between successful fetches
 * @param {(jpeg: Buffer) => void} opts.onFrame
 * @param {(state: string, msg?: string) => void} opts.onStateChange
 * @returns {{ stop: () => void }}
 */
function createSnapshotPuller({ snapshotUrl, username, password, intervalMs = DEFAULT_INTERVAL_MS, onFrame, onStateChange }) {
  let stopped = false;
  let timer = null;
  let consecutiveFails = 0;
  let backoff = intervalMs;

  const emit = (state, msg) => { if (!stopped) onStateChange(state, msg); };

  async function tick() {
    if (stopped) return;
    try {
      const jpeg = await fetchSnapshot(snapshotUrl, username, password);
      if (stopped) return;
      if (consecutiveFails > 0) {
        consecutiveFails = 0;
        backoff = intervalMs;
        emit("connected");
      }
      onFrame(jpeg);
      timer = setTimeout(tick, intervalMs);
    } catch (err) {
      if (stopped) return;
      consecutiveFails += 1;
      // Backoff: 1s, 2s, 4s, 8s, ... cap 60s
      backoff = Math.min(backoff * 2, 60000);
      const isAuth = /401|403/.test(err.message);
      const state = isAuth ? "authFailed" : "error";
      emit(state, err.message);
      // Stop entirely on auth failures — re-trying would just spam the camera
      if (isAuth) return;
      timer = setTimeout(tick, backoff);
    }
  }

  emit("connecting");
  // Small initial delay so multiple cams started at the same time don't
  // stampede the network
  timer = setTimeout(tick, 200);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { createSnapshotPuller, fetchSnapshot };
