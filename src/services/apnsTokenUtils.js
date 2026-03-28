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

/** Clear the push-to-start token after APNs rejection (400 BadDeviceToken or 410 expired). */
function clearPushToStartToken(userId) {
  return User.updateOne({ _id: userId }, { la_push_to_start_token: null });
}

/** Check if APNs response indicates a permanently invalid token (410 expired or 400 BadDeviceToken). */
function isTokenInvalid(result) {
  if (!result) return false;
  if (result.status === 410) return true;
  if (result.status === 400 && result.reason?.reason === "BadDeviceToken") return true;
  return false;
}

module.exports = { getActivityToken, clearActivityToken, clearPushToStartToken, isTokenInvalid };
