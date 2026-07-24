/**
 * expoPushToken -> User cache for the read hot path.
 *
 * The mobile app polls /printer/mqtt-state (and camera/state endpoints) every
 * ~5s, and each request resolved the caller with User.findOne({expo_push_token})
 * — ~768 Mongo round-trips/sec at ~3,800 users (worse when Mongo is
 * cross-region). This caches the token->user mapping in memory so those reads
 * skip Mongo.
 *
 * SECURITY: an entry maps a token to a bambu_uid, which routes camera frames,
 * live state, and control commands to a Bambu account. A stale bambu_uid could
 * route to the WRONG account, so:
 *   - the TTL is short (60s) — a hard backstop on staleness, NOT extended on
 *     read (a constantly-polled token still re-validates against Mongo each
 *     minute), and
 *   - every mutation of the token->user mapping (POST /register, /unregister,
 *     /activity-token, /push-to-start-token) calls invalidateUserToken()
 *     explicitly, so a real change is reflected immediately.
 * Only FOUND users are cached (never a null result), so a just-registered token
 * resolves from Mongo on its first read instead of being negatively cached.
 */
const User = require("../db/models/User");

const cache = new Map(); // expoPushToken -> { user, expiresAt }
const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 5000; // ~2-4k users + churn headroom

/**
 * Resolve the (lean) User for an expoPushToken, via the cache when fresh.
 * Returns the same shape as User.findOne({expo_push_token}).lean() — the user
 * object or null.
 */
async function getUserByPushToken(expoPushToken) {
  if (!expoPushToken) return null;

  const hit = cache.get(expoPushToken);
  if (hit) {
    if (Date.now() <= hit.expiresAt) {
      // Refresh LRU position (move to newest) WITHOUT extending the TTL — the
      // 60s freshness bound is measured from the DB fetch, not the last read.
      cache.delete(expoPushToken);
      cache.set(expoPushToken, hit);
      return hit.user;
    }
    cache.delete(expoPushToken);
  }

  const user = await User.findOne({ expo_push_token: expoPushToken }).lean();
  if (user) {
    cache.set(expoPushToken, { user, expiresAt: Date.now() + TTL_MS });
    if (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value; // insertion-ordered = LRU
      cache.delete(oldest);
    }
  }
  return user;
}

/** Drop a token's cached mapping — call after any change to its User record. */
function invalidateUserToken(expoPushToken) {
  if (expoPushToken) cache.delete(expoPushToken);
}

module.exports = { getUserByPushToken, invalidateUserToken };
