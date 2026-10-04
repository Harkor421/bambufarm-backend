/**
 * Shared APNs token validation utilities.
 * Used by both mqttPrinterService and poller to handle token invalidation.
 */
const User = require("../db/models/User");

function getActivityToken(user, printerId) {
  const tokens = user.la_activity_tokens;
  if (!tokens) return null;
  return tokens.get?.(printerId) || tokens[printerId] || null;
}

/** Clear a stored activity token after APNs rejection (400 BadDeviceToken or 410 expired). */
function clearActivityToken(userId, printerId) {
  return User.updateOne({ _id: userId }, { [`la_activity_tokens.${printerId}`]: null });
}

/** Check if APNs response indicates a permanently invalid token (410 expired or 400 BadDeviceToken). */
function isTokenInvalid(result) {
  if (!result) return false;
  if (result.status === 410) return true;
  if (result.status === 400 && result.reason?.reason === "BadDeviceToken") return true;
  return false;
}

/**
 * Apple says this token will never work again (410: the app was uninstalled,
 * Live Activities were turned off, or the activity ended). The only status that
 * is cured by deleting — see Alterna's apns.ts.
 */
function isTokenGone(result) {
  return !!result && result.status === 410;
}

/**
 * Remove a dead push-to-start token — only if the record still holds THAT
 * token, so a fresher one registered meanwhile is never wiped.
 */
function clearStartToken(userId, token) {
  return User.updateOne({ _id: userId, la_push_to_start_token: token }, { la_push_to_start_token: null });
}

module.exports = { getActivityToken, clearActivityToken, clearStartToken, isTokenInvalid, isTokenGone };
