/**
 * Network scanner for BambuLab printers.
 * Scans the local /24 subnet for devices with port 6000 open,
 * then matches them to cloud devices by trying each access code.
 */

const net = require("net");
const tls = require("tls");
const os = require("os");

const CAMERA_PORT = 6000;
const PROBE_TIMEOUT = 1200;
const AUTH_TIMEOUT = 3000;
const BATCH_SIZE = 50;

/**
 * Get the local IP address (first non-internal IPv4 address).
 */
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        // Skip VPN / virtual
        const first = parseInt(iface.address.split(".")[0], 10);
        if (first === 100) continue; // Tailscale / CGNAT
        return iface.address;
      }
    }
  }
  return null;
}

/**
 * Check if a single IP has port 6000 open.
 */
function probeIp(ip) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;

    const timer = setTimeout(() => {
      if (!done) { done = true; sock.destroy(); resolve(null); }
    }, PROBE_TIMEOUT);

    sock.connect(CAMERA_PORT, ip, () => {
      if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(ip); }
    });
    sock.on("error", () => {
      if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(null); }
    });
  });
}

/**
 * Build the 80-byte auth packet for camera protocol.
 */
function buildAuthPacket(accessCode) {
  const buf = Buffer.alloc(80, 0);
  buf.writeUInt32LE(0x40, 0);
  buf.writeUInt32LE(0x3000, 4);
  buf.write("bblp", 16, "ascii");
  buf.write(accessCode, 48, "ascii");
  return buf;
}

/**
 * Try TLS auth on an IP with a given access code.
 * Returns true if the printer responds with data (= correct code).
 */
function tryAuth(ip, accessCode) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; try { sock.destroy(); } catch {} resolve(false); }
    }, AUTH_TIMEOUT);

    let sock;
    try {
      sock = tls.connect({ host: ip, port: CAMERA_PORT, rejectUnauthorized: false }, () => {
        sock.write(buildAuthPacket(accessCode));
      });

      sock.on("data", () => {
        if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(true); }
      });
      sock.on("error", () => {
        if (!done) { done = true; clearTimeout(timer); try { sock.destroy(); } catch {} resolve(false); }
      });
      sock.on("close", () => {
        if (!done) { done = true; clearTimeout(timer); resolve(false); }
      });
    } catch {
      if (!done) { done = true; clearTimeout(timer); resolve(false); }
    }
  });
}

/**
 * Scan the local network for printers and match them to cloud devices.
 *
 * @param {{ dev_id: string, name: string, dev_access_code: string }[]} cloudDevices
 * @param {(event: { type: string, message: string, progress?: number }) => void} onProgress
 * @returns {Promise<{ devId: string, name: string, ip: string, accessCode: string }[]>}
 */
async function scanAndMatch(cloudDevices, onProgress) {
  const localIp = getLocalIp();
  if (!localIp) {
    onProgress({ type: "error", message: "Could not detect local network. Make sure you're on Wi-Fi or Ethernet." });
    return [];
  }

  const prefix = localIp.split(".").slice(0, 3).join(".");
  onProgress({ type: "status", message: `Scanning ${prefix}.0/24...`, progress: 0 });

  // Build IP list
  const ips = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${prefix}.${i}`;
    if (ip !== localIp) ips.push(ip);
  }

  // Scan in batches
  const found = [];
  let completed = 0;
  for (let i = 0; i < ips.length; i += BATCH_SIZE) {
    const batch = ips.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(probeIp));
    for (const r of results) {
      if (r) found.push(r);
    }
    completed += batch.length;
    onProgress({
      type: "status",
      message: `Scanning... found ${found.length} printer${found.length !== 1 ? "s" : ""}`,
      progress: (completed / ips.length) * 0.6,
    });
  }

  if (found.length === 0) {
    onProgress({ type: "status", message: "No printers found on network", progress: 1 });
    return [];
  }

  onProgress({
    type: "status",
    message: `Found ${found.length} printer${found.length !== 1 ? "s" : ""} — matching to your account...`,
    progress: 0.65,
  });

  // Match IPs to cloud devices
  const devicesWithCodes = cloudDevices.filter((d) => d.dev_access_code);
  const matched = [];
  const matchedDevIds = new Set();
  const matchedIps = new Set();

  for (const ip of found) {
    for (const device of devicesWithCodes) {
      if (matchedDevIds.has(device.dev_id) || matchedIps.has(ip)) continue;

      const ok = await tryAuth(ip, device.dev_access_code);
      if (ok) {
        matched.push({
          devId: device.dev_id,
          name: device.name || device.dev_id,
          ip,
          accessCode: device.dev_access_code,
        });
        matchedDevIds.add(device.dev_id);
        matchedIps.add(ip);
        onProgress({
          type: "match",
          message: `Matched ${device.name || device.dev_id} → ${ip}`,
          progress: 0.65 + (matched.length / found.length) * 0.3,
        });
        break;
      }
    }
  }

  onProgress({
    type: "status",
    message: `Done — matched ${matched.length} of ${found.length} printer${found.length !== 1 ? "s" : ""}`,
    progress: 1,
  });

  return matched;
}

module.exports = { scanAndMatch, getLocalIp };
