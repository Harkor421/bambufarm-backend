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

/**
 * Refresh tokens for a user if their access token is expired or about to expire.
 * Returns the current (or refreshed) access token.
 */
async function ensureFreshToken(user) {
  // Refresh if expires within 60 seconds
  if (user.bambu_token_expires_at > Date.now() + 60000) {
    return user.bambu_access_token;
  }

  log.info(`[TOKEN] Refreshing token for user ${user._id}`);

  const r = await axios.post(
    `${BAMBU_BASE}/v1/user-service/user/refresh`,
    { refresh_token: user.bambu_refresh_token },
    {
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    }
  );

  const tokens = extractTokens(r.data);
  if (!tokens) {
    throw new Error("Token refresh returned incomplete data");
  }

  // Update ALL users that share the same old refresh token (multiple devices, same Bambu account).
  // When Bambu Lab issues new tokens, the old refresh token is typically invalidated.
  const updateResult = await User.updateMany(
    { bambu_refresh_token: user.bambu_refresh_token },
    {
      bambu_access_token: tokens.accessToken,
      bambu_refresh_token: tokens.refreshToken,
      bambu_token_expires_at: tokens.expiresAt,
      fail_count: 0,
    }
  );

  log.info(`[TOKEN] Refreshed successfully for user ${user._id} (updated ${updateResult.modifiedCount} user(s))`);
  return tokens.accessToken;
}

module.exports = { ensureFreshToken };
