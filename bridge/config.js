/**
 * Config persistence for BambuBridge.
 *
 * Stored in the user's home directory so it survives app updates and packaging.
 * This module is stateless: loadConfig() returns a fresh merged object and
 * saveConfig(config) takes the caller's live config — index.js owns the single
 * mutable `config` binding.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// Migrate the old config directory name if it still exists. Runs once, at
// require time, matching the original module-load ordering.
const OLD_CONFIG_DIR = path.join(os.homedir(), ".bambufarm-bridge");
const CONFIG_DIR = path.join(os.homedir(), ".bambubridge");
if (!fs.existsSync(CONFIG_DIR) && fs.existsSync(OLD_CONFIG_DIR)) {
  try { fs.renameSync(OLD_CONFIG_DIR, CONFIG_DIR); } catch {}
}
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
const CONFIG_PATH = path.join(CONFIG_DIR, "bridge.config.json");

function defaultConfig() {
  return {
    bambuTokens: null, // { accessToken, refreshToken, expiresAt }
    printers: [],      // [{ devId, name, ip, accessCode }]
    cameras: [],       // [{ id, name, brand?, model?, ip?, snapshotUrl, username?, password?, boundPrinterId?, addedAt }]
  };
}

// Load persisted config merged over the defaults. Returns a fresh object; the
// caller assigns it to its live `config` binding (equivalent to the original
// in-place `config = { ...config, ...parsed }` since config === defaults here).
function loadConfig() {
  const config = defaultConfig();
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
    }
  } catch {}
  return config;
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch {}
}

module.exports = { defaultConfig, loadConfig, saveConfig, CONFIG_PATH };
