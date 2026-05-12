/**
 * Bambu access-token verification with in-memory caching.
 *
 * Used by wsManager to authenticate /ws/bridge, /ws/app, /ws/public/cameras
 * connections. Resolves a token to its Bambu uid via:
 *   1. In-memory cache (10 min TTL)
 *   2. DB lookup against User.bambu_access_token
 *   3. Last-resort call to Bambu's /my/profile API
 *
 * SECURITY: We do NOT trust the JWT payload locally. Bambu's JWTs carry a uid
 * claim, but we don't have Bambu's signing key, so we can't verify the
 * signature. Trusting the unsigned payload would let anyone forge a token with
 * a victim's publicly-discoverable uid and:
 *   - On /ws/app: receive the victim's camera frames
 *   - On /ws/bridge: inject arbitrary JPEGs into the victim's frame relay
 *     (fanned out to their app clients, cached for the public/admin camera
 *     feeds, and uploaded to R2 as mislabeled training data)
 *
 * The cache is only populated by successful DB or API lookups, never by JWT
 * decode, so forged tokens can't poison it.
 */

const https = require("https");
const crypto = require("crypto");
const log = require("../utils/logger");

// Shared HTTPS agent with connection pooling — reuses TCP connections to Bambu
// API instead of opening a fresh socket per auth call (fixes socket exhaustion
// under load).
const bambuHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 25,
  maxFreeSockets: 10,
  timeout: 10000,
  keepAliveMsecs: 30000,
});

// tokenHash → { uid, expiresAt }
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const TOKEN_CACHE_MAX = 5000; // ~2k users + churn headroom

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
  // Delete-then-set refreshes LRU position
  tokenCache.delete(key);
  tokenCache.set(key, { uid, expiresAt: Date.now() + TOKEN_CACHE_TTL });
  if (tokenCache.size > TOKEN_CACHE_MAX) {
    const firstKey = tokenCache.keys().next().value;
    tokenCache.delete(firstKey);
  }
}

/**
 * Resolve the Bambu uid for a given access token. Returns a uid string on
 * success, or null on failure.
 */
async function verifyBambuToken(accessToken) {
  // Fast path 1: cached uid
  const cached = getCachedUid(accessToken);
  if (cached) return cached;

  // Fast path 2: DB lookup. Every registered user has bambu_uid stored.
  try {
    const User = require("../db/models/User");
    const user = await User.findOne({ bambu_access_token: accessToken })
      .select("bambu_uid")
      .lean();
    if (user && user.bambu_uid) {
      cacheUid(accessToken, String(user.bambu_uid));
      return String(user.bambu_uid);
    }
  } catch (err) {
    log.warn(`[WS] DB lookup failed for token verify: ${err.message}`);
  }

  log.debug(`[WS] Token not in DB, falling back to Bambu API (length=${accessToken.length})`);

  // Last resort: call Bambu API. This path is expensive and rate-limited, so
  // it's wrapped in the same HTTPS keep-alive agent + cache.
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.bambulab.com",
        path: "/v1/user-service/my/profile",
        method: "GET",
        agent: bambuHttpsAgent,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          const status = res.statusCode;
          if (status === 200) {
            try {
              const data = JSON.parse(body);
              const uid =
                data.uid ||
                data.userId ||
                data.user_id ||
                data.id ||
                (data.data && (data.data.uid || data.data.userId || data.data.id));
              if (uid) {
                cacheUid(accessToken, String(uid));
                return resolve(String(uid));
              }
            } catch {}
            return resolve(null);
          }
          if (status === 429) {
            log.warn(`[WS] Bambu API rate-limited (429) on last-resort token verify`);
          } else if (status >= 500) {
            log.warn(`[WS] Bambu API error ${status} on last-resort token verify`);
          } else if (status === 401 || status === 403) {
            log.debug(`[WS] Bambu token rejected (${status})`);
          }
          resolve(null);
        });
      }
    );
    req.on("error", (err) => {
      log.warn(`[WS] Bambu API network error on last-resort token verify: ${err.message}`);
      resolve(null);
    });
    req.setTimeout(10000, () => {
      log.warn(`[WS] Bambu API timeout on last-resort token verify`);
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

module.exports = { verifyBambuToken };
