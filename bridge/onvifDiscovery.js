/**
 * ONVIF WS-Discovery — finds IP cameras on the LAN via UDP multicast.
 *
 * Pure-Node implementation (no SOAP library). Sends a Probe message to
 * 239.255.255.250:3702 for type `dn:NetworkVideoTransmitter` and parses
 * ProbeMatch responses to extract the camera's SOAP endpoint (XAddrs)
 * plus brand/model hints from the Scopes field.
 *
 * Returns lightweight discovery records — the user still needs to configure
 * snapshot URL + credentials per camera. SOAP-based GetSnapshotUri is left
 * to a follow-up because it needs WSSE digest auth, which is vendor-fragile.
 */

const dgram = require("dgram");
const crypto = require("crypto");

const ONVIF_MULTICAST_ADDR = "239.255.255.250";
const ONVIF_PORT = 3702;
const DISCOVERY_TIMEOUT_MS = 4000;

function buildProbe() {
  const messageId = "uuid:" + crypto.randomUUID();
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ` +
      `xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ` +
      `xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ` +
      `xmlns:dn="http://www.onvif.org/ver10/network/wsdl">` +
      `<e:Header>` +
      `<w:MessageID>${messageId}</w:MessageID>` +
      `<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>` +
      `<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>` +
      `</e:Header>` +
      `<e:Body>` +
      `<d:Probe>` +
      `<d:Types>dn:NetworkVideoTransmitter</d:Types>` +
      `</d:Probe>` +
      `</e:Body>` +
      `</e:Envelope>`,
    "utf8"
  );
}

// ONVIF scopes are URI-encoded segments like:
//   onvif://www.onvif.org/name/Hikvision%20DS-2CD2143G2-IS
//   onvif://www.onvif.org/hardware/DS-2CD2143G2-IS
//   onvif://www.onvif.org/location/country/china
function parseScopes(xml) {
  const out = { brand: null, model: null, name: null, country: null };
  const scopesMatch = xml.match(/<[\w:]*Scopes[^>]*>([\s\S]*?)<\/[\w:]*Scopes>/i);
  if (!scopesMatch) return out;
  const scopes = scopesMatch[1].split(/\s+/);
  for (const s of scopes) {
    if (!s.startsWith("onvif://")) continue;
    const decoded = decodeURIComponent(s);
    const m = decoded.match(/onvif:\/\/[^/]+\/(\w+)\/(.+)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === "name") out.name = val;
    else if (key === "hardware") out.model = val;
    else if (key === "manufacturer") out.brand = val;
    else if (key === "country") out.country = val;
  }
  if (!out.brand && out.name) {
    // Some cams put "Hikvision DS-2CD..." in name; first word is usually brand.
    out.brand = out.name.split(/\s+/)[0];
  }
  return out;
}

function parseXAddrs(xml) {
  const m = xml.match(/<[\w:]*XAddrs[^>]*>([\s\S]*?)<\/[\w:]*XAddrs>/i);
  if (!m) return [];
  return m[1].trim().split(/\s+/).filter((u) => u.startsWith("http"));
}

function ipFromXAddr(xAddr) {
  try {
    const u = new URL(xAddr);
    return u.hostname;
  } catch {
    return null;
  }
}

/**
 * Discover ONVIF cameras on the LAN.
 *
 * @param {(record: object) => void} onDevice - called for each unique camera as it responds
 * @param {number} timeoutMs - how long to listen for responses
 * @returns {Promise<Array<{ ip, xAddr, brand, model, name, urn }>>}
 */
function discover(onDevice, timeoutMs = DISCOVERY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map(); // urn → record
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      try { sock.close(); } catch {}
    };

    sock.on("message", (msg) => {
      const xml = msg.toString("utf8");
      // Filter for ProbeMatch responses
      if (!/ProbeMatch/i.test(xml)) return;
      const xAddrs = parseXAddrs(xml);
      if (xAddrs.length === 0) return;
      const xAddr = xAddrs[0];
      const ip = ipFromXAddr(xAddr);
      if (!ip) return;

      // Use EndpointReference Address as a stable URN if present, else use xAddr
      const urnMatch = xml.match(/<[\w:]*Address[^>]*>(urn:[^<]+)<\/[\w:]*Address>/i);
      const urn = urnMatch ? urnMatch[1] : xAddr;
      if (found.has(urn)) return;

      const scopes = parseScopes(xml);
      const record = {
        ip,
        xAddr,
        urn,
        brand: scopes.brand,
        model: scopes.model,
        name: scopes.name || `${scopes.brand || "ONVIF"} ${scopes.model || ip}`.trim(),
      };
      found.set(urn, record);
      try { onDevice && onDevice(record); } catch {}
    });

    sock.on("error", (err) => {
      cleanup();
      reject(err);
    });

    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
        sock.setMulticastTTL(2);
      } catch {}
      const probe = buildProbe();
      // Send 3 probes ~500ms apart — UDP can drop, and some cameras respond slowly
      const send = () => {
        if (closed) return;
        sock.send(probe, 0, probe.length, ONVIF_PORT, ONVIF_MULTICAST_ADDR, () => {});
      };
      send();
      setTimeout(send, 500);
      setTimeout(send, 1500);

      setTimeout(() => {
        cleanup();
        resolve([...found.values()]);
      }, timeoutMs);
    });
  });
}

module.exports = { discover };
