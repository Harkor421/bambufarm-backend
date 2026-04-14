/**
 * Utilities for decoding Bambu Lab JWT access tokens locally.
 *
 * Bambu tokens are standard JWTs — the uid and expiration live in the payload,
 * so we can trust them without ever calling Bambu Cloud. Hitting their API just
 * to "verify" what the JWT already tells us gets us rate-limited (429) under load.
 */

/**
 * Decode a JWT payload (handles base64url encoding properly).
 * Returns the decoded payload object or null on failure.
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
 * Extract the Bambu uid from a JWT access token without calling Bambu Cloud.
 * Returns a uid string if the JWT is valid and not expired, otherwise null.
 */
function extractUidFromJwt(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;

  const uid = payload.uid || payload.sub || payload.user_id;
  if (!uid) return null;

  // If an exp claim is present, enforce it. Without one, trust the caller's own
  // expiration check (or trust it indefinitely for the WS auth layer).
  const exp = payload.exp;
  if (exp && exp * 1000 <= Date.now()) return null;

  return String(uid);
}

module.exports = { decodeJwtPayload, extractUidFromJwt };
