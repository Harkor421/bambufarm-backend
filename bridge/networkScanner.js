/**
 * Network scanner for BambuLab printers.
 * Scans the local /24 subnet for devices with a camera port open, then
 * matches them to cloud devices by trying each access code.
 *
 * Two camera protocols exist across the lineup:
 *   - port 6000: JPEG-over-TLS (P1 series, A1 series)
 *   - port 322:  RTSPS "LAN Mode Liveview" (X1 series, H2 family, P2S)
 * We probe both ports and tag each match with `protocol: "jpeg" | "rtsp"` so
 * the bridge can pick the right stream client.
 */

const net = require("net");
const tls = require("tls");
const os = require("os");
const crypto = require("crypto");

const CAMERA_PORT = 6000;
const RTSP_PORT = 322;
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
 * Check if a single IP has `port` open. Resolves true/false.
 */
function probePort(ip, port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;

    const timer = setTimeout(() => {
      if (!done) { done = true; sock.destroy(); resolve(false); }
    }, PROBE_TIMEOUT);

    sock.connect(port, ip, () => {
      if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(true); }
    });
    sock.on("error", () => {
      if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(false); }
    });
  });
}

/**
 * Probe both camera ports on an IP.
 * Resolves { ip, jpeg, rtsp } or null when neither port is open.
 */
async function probeIp(ip) {
  const [jpeg, rtsp] = await Promise.all([
    probePort(ip, CAMERA_PORT),
    probePort(ip, RTSP_PORT),
  ]);
  if (!jpeg && !rtsp) return null;
  return { ip, jpeg, rtsp };
}

/**
 * Build the 80-byte auth packet for the port-6000 camera protocol.
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
 * Try TLS auth on an IP with a given access code (port-6000 protocol).
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
 * RTSP DESCRIBE over TLS to verify an access code against a port-322 printer.
 * Sends Basic auth first; if the printer answers 401 with a Digest challenge,
 * retries once with a computed Digest response. Resolves true only on a
 * definitive 200.
 */
function verifyRtsp(ip, accessCode) {
  const uri = `rtsp://${ip}:${RTSP_PORT}/streaming/live/1`;

  function digestAuthHeader(challenge) {
    // Parse realm/nonce out of: Digest realm="...", nonce="..."
    const realm = /realm="([^"]*)"/.exec(challenge)?.[1];
    const nonce = /nonce="([^"]*)"/.exec(challenge)?.[1];
    if (!realm || !nonce) return null;
    const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
    const ha1 = md5(`bblp:${realm}:${accessCode}`);
    const ha2 = md5(`DESCRIBE:${uri}`);
    const response = md5(`${ha1}:${nonce}:${ha2}`);
    return `Digest username="bblp", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  }

  function request(authHeader, cseq) {
    return (
      `DESCRIBE ${uri} RTSP/1.0\r\n` +
      `CSeq: ${cseq}\r\n` +
      `User-Agent: BambuBridge\r\n` +
      `Accept: application/sdp\r\n` +
      `Authorization: ${authHeader}\r\n` +
      `\r\n`
    );
  }

  return new Promise((resolve) => {
    let done = false;
    let sock;
    let phase = 1; // 1 = basic attempt, 2 = digest retry
    let buf = "";

    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), AUTH_TIMEOUT);

    try {
      sock = tls.connect({ host: ip, port: RTSP_PORT, rejectUnauthorized: false }, () => {
        const basic = `Basic ${Buffer.from(`bblp:${accessCode}`).toString("base64")}`;
        sock.write(request(basic, 1));
      });

      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        // Wait for a full status line + headers
        if (!buf.includes("\r\n\r\n")) return;

        const status = /^RTSP\/1\.0 (\d{3})/.exec(buf)?.[1];
        if (status === "200") return finish(true);

        if (status === "401" && phase === 1) {
          const challenge = /www-authenticate:\s*(.+)/i.exec(buf)?.[1];
          const digest = challenge && challenge.trim().startsWith("Digest")
            ? digestAuthHeader(challenge)
            : null;
          if (!digest) return finish(false);
          phase = 2;
          buf = "";
          sock.write(request(digest, 2));
          return;
        }

        finish(false);
      });

      sock.on("error", () => finish(false));
      sock.on("close", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/**
 * Scan the local network for printers and match them to cloud devices.
 *
 * @param {{ dev_id: string, name: string, dev_access_code: string }[]} cloudDevices
 * @param {(event: { type: string, message: string, progress?: number }) => void} onProgress
 * @returns {Promise<{ devId: string, name: string, ip: string, accessCode: string, protocol: "jpeg"|"rtsp" }[]>}
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
  const found = []; // [{ ip, jpeg, rtsp }]
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

  // Match IPs to cloud devices. Prefer the JPEG port when both are open (it's
  // the protocol older firmwares expose reliably); fall back to RTSP.
  const devicesWithCodes = cloudDevices.filter((d) => d.dev_access_code);
  const matched = [];
  const matchedDevIds = new Set();
  const matchedIps = new Set();

  for (const cand of found) {
    for (const device of devicesWithCodes) {
      if (matchedDevIds.has(device.dev_id) || matchedIps.has(cand.ip)) continue;

      let protocol = null;
      if (cand.jpeg && (await tryAuth(cand.ip, device.dev_access_code))) {
        protocol = "jpeg";
      } else if (cand.rtsp && (await verifyRtsp(cand.ip, device.dev_access_code))) {
        protocol = "rtsp";
      }

      if (protocol) {
        matched.push({
          devId: device.dev_id,
          name: device.name || device.dev_id,
          ip: cand.ip,
          accessCode: device.dev_access_code,
          protocol,
        });
        matchedDevIds.add(device.dev_id);
        matchedIps.add(cand.ip);
        onProgress({
          type: "match",
          message: `Matched ${device.name || device.dev_id} → ${cand.ip} (${protocol})`,
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
