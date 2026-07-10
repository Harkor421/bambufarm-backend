const axios = require("axios");
const User = require("../db/models/User");
const log = require("../utils/logger");

const BAMBU_BASE = "https://api.bambulab.com";

/**
 * Port of extractTokens from src/api/bambu/auth.js:26-44
 */
function extractTokens(payload) {
  const p = payload?.data ?? payload ?? {};
  const access = p.accessToken ?? p.access_token ?? p.access ?? null;
  const refresh = p.refreshToken ?? p.refresh_token ?? p.refresh ?? null;
  const expiresIn = p.expiresIn ?? p.expires_in ?? p.expires ?? null;
  if (!access || !refresh || !expiresIn) return null;
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() + Number(expiresIn) * 1000,
  };
}

// Dedup concurrent refreshes for the SAME refresh token. The poller runs many
// workers in parallel and MQTT setup also refreshes, so without this two callers
// read the same old refresh token, both POST /refresh, and the second update
// overwrites the token the first already rotated — invalidating it for every
// device on the account. Keyed by refresh_token → in-flight Promise.
const _inflightRefresh = new Map();

/**
 * Refresh tokens for a user if their access token is expired or about to expire.
 * Returns the current (or refreshed) access token.
 */
async function ensureFreshToken(user) {
  // Refresh if expires within 60 seconds
  if (user.bambu_token_expires_at > Date.now() + 60000) {
    return user.bambu_access_token;
  }

  const rt = user.bambu_refresh_token;
  const existing = _inflightRefresh.get(rt);
  if (existing) return existing;

  const task = (async () => {
    log.info(`[TOKEN] Refreshing token for user ${user._id}`);

    // Endpoint is /refreshtoken (one word) with a camelCase `refreshToken`
    // field — /refresh returns 404 and snake_case yields a 400. (Bambu may
    // still 401 a valid token; callers treat refresh as best-effort.)
    const r = await axios.post(
      `${BAMBU_BASE}/v1/user-service/user/refreshtoken`,
      { refreshToken: rt },
      {
        timeout: 15000,
        headers: { "Content-Type": "application/json" },
      }
    );

    const tokens = extractTokens(r.data);
    if (!tokens) {
      throw new Error("Token refresh returned incomplete data");
    }

    // Update ALL users still holding the SAME old refresh token (multiple
    // devices, same Bambu account). Matching on the old token value is a
    // compare-and-swap: a record already rotated by a racing refresh won't
    // match, so we never clobber a newer token.
    const updateResult = await User.updateMany(
      { bambu_refresh_token: rt },
      {
        bambu_access_token: tokens.accessToken,
        bambu_refresh_token: tokens.refreshToken,
        bambu_token_expires_at: tokens.expiresAt,
        fail_count: 0,
      }
    );

    log.info(`[TOKEN] Refreshed successfully for user ${user._id} (updated ${updateResult.modifiedCount} user(s))`);
    return tokens.accessToken;
  })();

  _inflightRefresh.set(rt, task);
  try {
    return await task;
  } finally {
    _inflightRefresh.delete(rt);
  }
}

module.exports = { ensureFreshToken };
