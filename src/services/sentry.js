/**
 * Sentry error tracking — wraps @sentry/node so the rest of the codebase
 * doesn't need to import Sentry directly.
 *
 * Initialized at process startup BEFORE other imports so Sentry's auto-instrumentation
 * (Express, HTTP, console errors) catches everything from the moment the app boots.
 *
 * No-op if SENTRY_DSN isn't set, so local development and tests are unaffected.
 */

const Sentry = require("@sentry/node");
const log = require("../utils/logger");

let initialized = false;

function init() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    log.info("[SENTRY] SENTRY_DSN not set — error tracking disabled");
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "production",
    release: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7),
    // Sample 10% of transactions for performance monitoring; 100% of errors
    tracesSampleRate: 0.1,
    // Don't capture every console log — only errors/warns we explicitly send
    integrations: [],
    // Filter out noise from expected Bambu API failures
    beforeSend(event, hint) {
      const err = hint?.originalException;
      const msg = err?.message || event?.message || "";
      // Bambu rate limits and 401s are expected and handled — don't page on them
      if (typeof msg === "string" && (
        msg.includes("status code 429") ||
        msg.includes("status code 401") ||
        msg.includes("Auth timeout")
      )) {
        return null;
      }
      return event;
    },
  });

  initialized = true;
  log.info(`[SENTRY] Initialized (env=${process.env.RAILWAY_ENVIRONMENT_NAME || "dev"})`);
}

/** Capture an exception with optional context. Safe to call when uninitialized. */
function captureException(err, context) {
  if (!initialized) return;
  try {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {}
}

/** Capture a message at warning level. Safe to call when uninitialized. */
function captureMessage(message, context) {
  if (!initialized) return;
  try {
    Sentry.captureMessage(message, { level: "warning", extra: context });
  } catch {}
}

/** Express error handler — mounts Sentry's request handler in the chain. */
function expressErrorHandler() {
  if (!initialized) return (err, _req, _res, next) => next(err);
  return Sentry.Handlers ? Sentry.Handlers.errorHandler() : (err, _req, _res, next) => {
    Sentry.captureException(err);
    next(err);
  };
}

module.exports = { init, captureException, captureMessage, expressErrorHandler, Sentry };
