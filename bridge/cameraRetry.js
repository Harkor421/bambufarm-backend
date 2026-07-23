/**
 * Per-printer camera reconnect tracking. Prevents tight retry loops when a
 * printer is unreachable (LAN-only mode off, wrong access code, IP changed,
 * etc.) — without this the bridge retried every 5 seconds forever, spamming
 * the printer and the user's log file. After too many consecutive failures it
 * stops retrying entirely; the user has to manually re-scan (which clears the
 * state via clearAllFailures) to recover.
 *
 * The failure Map is private to this module — callers go through the accessors.
 */

const cameraFailures = new Map(); // devId → { count, lastFailAt, suspended, suspendedReason? }
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 5 * 60 * 1000; // cap reconnect delay at 5 min
const RETRY_CIRCUIT_BREAK = 12;     // stop retrying after this many failures

function getRetryDelay(devId) {
  const fail = cameraFailures.get(devId);
  if (!fail) return RETRY_BASE_MS;
  // Exponential: 5s, 10s, 20s, 40s, 80s, 160s, 300s (capped)
  return Math.min(RETRY_BASE_MS * Math.pow(2, fail.count - 1), RETRY_MAX_MS);
}

function recordFailure(devId, kind) {
  const fail = cameraFailures.get(devId) || { count: 0, lastFailAt: 0, suspended: false };
  // Auth failures are permanent until config is re-scanned — don't retry at all.
  if (kind === "authFailed") {
    fail.suspended = true;
    fail.suspendedReason = "auth";
  }
  fail.count += 1;
  fail.lastFailAt = Date.now();
  if (fail.count >= RETRY_CIRCUIT_BREAK) {
    fail.suspended = true;
    fail.suspendedReason = fail.suspendedReason || "too-many-failures";
  }
  cameraFailures.set(devId, fail);
  return fail;
}

function clearFailures(devId) {
  cameraFailures.delete(devId);
}

function clearAllFailures() {
  cameraFailures.clear();
}

function isSuspended(devId) {
  return !!cameraFailures.get(devId)?.suspended;
}

// Returns 0 (not undefined) for an unknown printer so callers can compare
// numerically, e.g. getFailureCount(id) > 2.
function getFailureCount(devId) {
  return cameraFailures.get(devId)?.count || 0;
}

module.exports = {
  getRetryDelay,
  recordFailure,
  clearFailures,
  clearAllFailures,
  isSuspended,
  getFailureCount,
};
