/**
 * Counts the bytes this process sends, by category, so egress cost (the only
 * billed network on Railway) can be attributed instead of guessed.
 *
 * Application-level payload bytes: TLS/TCP/WebSocket framing overhead is not
 * included, so the totals sit a little under Railway's NETWORK_TX figure. The
 * ratios between categories are what matter. In memory, reset on restart.
 */

const startedAt = Date.now();
const totals = new Map(); // category → { bytes, messages }

function byteLength(data) {
  if (data == null) return 0;
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

function add(category, bytes) {
  let t = totals.get(category);
  if (!t) {
    t = { bytes: 0, messages: 0 };
    totals.set(category, t);
  }
  t.bytes += bytes;
  t.messages += 1;
}

/** Wrap a ws socket's send so everything it sends is counted. */
function meterSocket(ws, categoryFor) {
  const send = ws.send.bind(ws);
  ws.send = (data, opts, cb) => {
    try {
      add(typeof categoryFor === "function" ? categoryFor(data) : categoryFor, byteLength(data));
    } catch {
      // metering must never break a send
    }
    return send(data, opts, cb);
  };
}

/** Express middleware: counts response body bytes per route group. */
function httpMiddleware(req, res, next) {
  // "/api/printer/mqtt-state?x" → "http:/api/printer/mqtt-state"; ids collapsed.
  const group =
    "http:" +
    req.path
      .split("/")
      .slice(0, 4)
      .map((seg) => (/^[0-9A-Za-z]{12,}$/.test(seg) || /^\d+$/.test(seg) ? ":id" : seg))
      .join("/");
  let bytes = 0;
  const write = res.write;
  const end = res.end;
  res.write = function (chunk, ...rest) {
    bytes += byteLength(chunk);
    return write.call(this, chunk, ...rest);
  };
  res.end = function (chunk, ...rest) {
    if (chunk && typeof chunk !== "function") bytes += byteLength(chunk);
    add(group, bytes);
    return end.call(this, chunk, ...rest);
  };
  next();
}

function snapshot(now = Date.now()) {
  const hours = Math.max((now - startedAt) / 3600000, 1 / 60);
  let all = 0;
  for (const t of totals.values()) all += t.bytes;
  const categories = [...totals.entries()]
    .map(([category, t]) => ({
      category,
      bytes: t.bytes,
      messages: t.messages,
      share: all ? Math.round((t.bytes / all) * 1000) / 10 : 0,
      gbPerDay: Math.round(((t.bytes / hours) * 24) / 1e7) / 100,
      avgBytes: t.messages ? Math.round(t.bytes / t.messages) : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);
  return {
    since: new Date(startedAt).toISOString(),
    hours: Math.round(hours * 100) / 100,
    totalBytes: all,
    totalGbPerDay: Math.round(((all / hours) * 24) / 1e7) / 100,
    categories,
  };
}

// ─── Socket-level metering ──────────────────────────────────────────────────
// The app-level counters above only see payload we write ourselves (~0.2
// GB/day), while Railway bills ~11 GB/day of TX. This attributes the real
// socket bytes — MQTT to Bambu, MongoDB, outbound HTTPS, inbound app/bridge
// connections — plus the container NIC total from /proc/net/dev, so the gap
// (TCP/IP headers + ACKs) is visible too.

const net = require("net");
const tls = require("tls");
const fs = require("fs");

const SAMPLE_MS = 60 * 1000;
const sockTotals = new Map(); // category → { written, read, opened, closed }
const live = new Set(); // sockets currently tracked (removed on close)
const lastSeen = new WeakMap(); // socket → { w, r }
const meta = new WeakMap(); // socket → { port, host, inbound }
let iface = null; // { name, tx0, rx0, tx, rx, at0, at }
let installed = false;

function bucket(cat) {
  let t = sockTotals.get(cat);
  if (!t) {
    t = { written: 0, read: 0, opened: 0, closed: 0 };
    sockTotals.set(cat, t);
  }
  return t;
}

function categoryOf(socket) {
  const m = meta.get(socket) || {};
  if (m.inbound) return "sock:inbound (apps/bridges/http)";
  const port = m.port ?? socket.remotePort;
  if (port === 8883) return "sock:mqtt-bambu (8883)";
  if (port === 27017) return "sock:mongodb (27017)";
  if (port === 443) return `sock:https ${m.host || socket.servername || socket.remoteAddress || "?"}`;
  return `sock:out:${port ?? "?"}`;
}

function flush(socket) {
  const prev = lastSeen.get(socket) || { w: 0, r: 0 };
  const w = socket.bytesWritten || 0;
  const r = socket.bytesRead || 0;
  if (w === prev.w && r === prev.r) return;
  const t = bucket(categoryOf(socket));
  t.written += Math.max(0, w - prev.w);
  t.read += Math.max(0, r - prev.r);
  lastSeen.set(socket, { w, r });
}

function track(socket, info = {}) {
  if (!socket || live.has(socket) || lastSeen.has(socket)) return;
  meta.set(socket, { ...info });
  lastSeen.set(socket, { w: 0, r: 0 });
  live.add(socket);
  socket.once("connect", () => {
    const m = meta.get(socket) || {};
    if (m.port == null && socket.remotePort) m.port = socket.remotePort;
    meta.set(socket, m);
    bucket(categoryOf(socket)).opened += 1;
  });
  socket.once("close", () => {
    try {
      flush(socket);
      bucket(categoryOf(socket)).closed += 1;
    } catch {
      // never break a close
    }
    live.delete(socket);
  });
}

/** Host/port from the (port, host, opts) | (opts) | (path) overloads. */
function targetOf(args) {
  const a0 = args[0];
  if (a0 && typeof a0 === "object") return { port: a0.port != null ? Number(a0.port) : undefined, host: a0.servername || a0.host };
  if (typeof a0 === "number" || /^\d+$/.test(String(a0))) {
    return { port: Number(a0), host: typeof args[1] === "string" ? args[1] : args[1]?.servername || args[1]?.host };
  }
  return {};
}

function wrapConnect(mod, name) {
  const orig = mod[name];
  if (typeof orig !== "function" || orig.__egressWrapped) return;
  const wrapped = function (...args) {
    const socket = orig.apply(this, args);
    try {
      track(socket, targetOf(args));
    } catch {
      // metering must never break a connect
    }
    return socket;
  };
  wrapped.__egressWrapped = true;
  mod[name] = wrapped;
}

function readIface() {
  try {
    const lines = fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2);
    let best = null;
    for (const line of lines) {
      const [rawName, rest] = line.split(":");
      if (!rest) continue;
      const name = rawName.trim();
      if (name === "lo") continue;
      const f = rest.trim().split(/\s+/).map(Number);
      const rx = f[0];
      const tx = f[8];
      if (!best || tx > best.tx) best = { name, rx, tx };
    }
    return best;
  } catch {
    return null; // not Linux / no procfs (local dev)
  }
}

function sample() {
  for (const s of live) {
    try {
      flush(s);
    } catch {
      // ignore
    }
  }
  const nic = readIface();
  if (nic) {
    const now = Date.now();
    if (!iface || iface.name !== nic.name) iface = { name: nic.name, tx0: nic.tx, rx0: nic.rx, at0: now };
    iface.tx = nic.tx;
    iface.rx = nic.rx;
    iface.at = now;
  }
}

/**
 * Hook net/tls connects + the HTTP server's inbound sockets. Call once, as
 * early as possible (src/index.js line 2) so every library's sockets go
 * through the wrapped functions.
 */
function installSocketMeter() {
  if (installed) return;
  installed = true;
  wrapConnect(net, "connect");
  wrapConnect(net, "createConnection");
  wrapConnect(tls, "connect");
  sample();
  const timer = setInterval(sample, SAMPLE_MS);
  if (timer.unref) timer.unref();
}

/** Track every inbound connection of an http.Server. */
function meterServer(server) {
  server.on("connection", (socket) => {
    try {
      track(socket, { inbound: true });
      bucket(categoryOf(socket)).opened += 1;
    } catch {
      // ignore
    }
  });
}

function socketSnapshot(now = Date.now()) {
  sample();
  const hours = Math.max((now - startedAt) / 3600000, 1 / 60);
  const perDay = (b) => Math.round(((b / hours) * 24) / 1e7) / 100;
  let totalW = 0;
  for (const t of sockTotals.values()) totalW += t.written;
  const categories = [...sockTotals.entries()]
    .map(([category, t]) => ({
      category,
      writtenGbPerDay: perDay(t.written),
      readGbPerDay: perDay(t.read),
      shareOfWritten: totalW ? Math.round((t.written / totalW) * 1000) / 10 : 0,
      opened: t.opened,
      closed: t.closed,
      writtenBytes: t.written,
      readBytes: t.read,
    }))
    .sort((a, b) => b.writtenBytes - a.writtenBytes);
  let nic = null;
  if (iface && iface.at > iface.at0) {
    const h = (iface.at - iface.at0) / 3600000;
    nic = {
      name: iface.name,
      hours: Math.round(h * 100) / 100,
      txGbPerDay: Math.round((((iface.tx - iface.tx0) / h) * 24) / 1e7) / 100,
      rxGbPerDay: Math.round((((iface.rx - iface.rx0) / h) * 24) / 1e7) / 100,
    };
  }
  return { liveSockets: live.size, socketWrittenGbPerDay: perDay(totalW), nic, categories };
}

function _reset() {
  totals.clear();
  sockTotals.clear();
}

module.exports = {
  add,
  byteLength,
  meterSocket,
  httpMiddleware,
  snapshot,
  installSocketMeter,
  meterServer,
  socketSnapshot,
  _reset,
};
