/**
 * Bambu Lab Cloud API client for the bridge.
 * Handles login (email/password + optional 2FA), token refresh,
 * and fetching printer list with access codes.
 */

const https = require("https");

const BASE = "https://api.bambulab.com";

function request(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const data = body ? JSON.stringify(body) : null;

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "BambuFarm-Bridge/1.0",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) headers["Content-Length"] = Buffer.byteLength(data);

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method,
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            if (res.statusCode >= 400) {
              reject({ status: res.statusCode, ...json });
            } else {
              resolve(json);
            }
          } catch {
            reject({ status: res.statusCode, message: body });
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    if (data) req.write(data);
    req.end();
  });
}

function extractTokens(data) {
  const p = data?.data || data;
  const access = p?.accessToken || p?.access_token;
  const refresh = p?.refreshToken || p?.refresh_token;
  const expiresIn = p?.expiresIn || p?.expires_in;
  if (!access || !refresh || !expiresIn) return null;
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

/**
 * Login with email/password.
 * Returns { tokens } on success, or { needsVerification: true } if 2FA required.
 */
async function login(email, password) {
  const resp = await request("POST", "/v1/user-service/user/login", {
    body: { account: email, password },
  });
  const tokens = extractTokens(resp);
  if (tokens) return { tokens };
  return { needsVerification: true };
}

/**
 * Submit 2FA verification code.
 */
async function verifyCode(email, code) {
  const resp = await request("POST", "/v1/user-service/user/login", {
    body: { account: email, code },
  });
  const tokens = extractTokens(resp);
  if (!tokens) throw new Error("Verification succeeded but no tokens returned");
  return tokens;
}

/**
 * Refresh access token.
 */
async function refreshToken(refreshToken) {
  const resp = await request("POST", "/v1/user-service/user/refresh", {
    body: { refresh_token: refreshToken },
  });
  const tokens = extractTokens(resp);
  if (!tokens) throw new Error("Refresh succeeded but no tokens returned");
  return tokens;
}

/**
 * Fetch bound devices with access codes.
 * Returns [{ dev_id, name, dev_access_code, dev_model_name, ... }]
 */
async function fetchPrinters(accessToken) {
  const resp = await request("GET", "/v1/iot-service/api/user/bind", {
    token: accessToken,
  });
  return resp?.devices || [];
}

module.exports = { login, verifyCode, refreshToken, fetchPrinters };
