const LOG_LEVEL = process.env.LOG_LEVEL || "info"; // Don't import config here to avoid circular deps

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function ts() {
  return new Date().toISOString();
}

module.exports = {
  debug: (...args) => current <= LEVELS.debug && console.log(`[${ts()}] DEBUG`, ...args),
  info: (...args) => current <= LEVELS.info && console.log(`[${ts()}]`, ...args),
  warn: (...args) => current <= LEVELS.warn && console.warn(`[${ts()}] WARN`, ...args),
  error: (...args) => current <= LEVELS.error && console.error(`[${ts()}] ERROR`, ...args),
};
