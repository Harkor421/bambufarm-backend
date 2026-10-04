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

function _reset() {
  totals.clear();
}

module.exports = { add, byteLength, meterSocket, httpMiddleware, snapshot, _reset };
