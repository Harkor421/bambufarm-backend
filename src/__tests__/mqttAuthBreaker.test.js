/**
 * Guards the MQTT auth circuit-breaker: a dead-Bambu-token connection that the
 * broker CONNACK-refuses must SUSPEND after N consecutive auth rejections (so it
 * stops reconnecting every 10-40s forever), while a valid token — or a transient
 * network blip — must NEVER be suspended.
 */
const { EventEmitter } = require("events");

// Fake mqtt client: an EventEmitter with the methods the connection calls.
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.stream = { destroyed: false };
    this.ended = false;
  }
  end() { this.ended = true; return this; }
  subscribe() {}
  publish() {}
  setMaxListeners() {}
}

let mockClient;
jest.mock("mqtt", () => ({ connect: jest.fn(() => mockClient) }));

const PrinterMqttConnection = require("../services/mqttPrinterConnection");

const conns = [];
function makeConn(token = "tokDEAD") {
  const c = new PrinterMqttConnection({
    userId: "u1",
    bambuUid: "uid1",
    accessToken: token,
    printerIds: new Set(["D1"]),
    onStateChange: async () => {},
    onProgressUpdate: async () => {},
    onOffline: () => {},
  });
  conns.push(c);
  return c;
}

const authErr = (code) => Object.assign(new Error("Connection refused"), { code });

beforeEach(() => { mockClient = new FakeClient(); });
afterEach(() => { conns.forEach((c) => { try { c.stop(); } catch {} }); conns.length = 0; });

describe("MQTT auth circuit breaker", () => {
  test("suspends after 3 consecutive CONNACK code-5 rejections and ends the client", () => {
    const conn = makeConn("tokDEAD");
    conn.connect();
    mockClient.emit("error", authErr(5));
    mockClient.emit("error", authErr(5));
    expect(conn.authSuspended).toBe(false); // 2 < threshold(3)
    mockClient.emit("error", authErr(5)); // 3rd
    expect(conn.authSuspended).toBe(true);
    expect(conn.suspendedToken).toBe("tokDEAD");
    expect(conn.suspendedAt).toBeGreaterThan(0);
    expect(mockClient.ended).toBe(true); // reconnect loop halted
    expect(conn.stopped).toBe(false); // NOT stopped — scan can still rebuild on re-login
  });

  test("code 4 and 135 also count as auth rejections", () => {
    const conn = makeConn();
    conn.connect();
    mockClient.emit("error", authErr(4));
    mockClient.emit("error", authErr(135));
    mockClient.emit("error", authErr(5));
    expect(conn.authSuspended).toBe(true);
  });

  test("a successful connect resets the counter (a recovered token is never left flagged)", () => {
    const conn = makeConn();
    conn.connect();
    mockClient.emit("error", authErr(5));
    mockClient.emit("error", authErr(5));
    mockClient.emit("connect");
    expect(conn.authFailCount).toBe(0);
    expect(conn.authSuspended).toBe(false);
    mockClient.emit("error", authErr(5)); // one more — must not suspend (counter reset)
    expect(conn.authSuspended).toBe(false);
  });

  test("network errors (string errno) NEVER count toward suspension", () => {
    const conn = makeConn();
    conn.connect();
    for (let i = 0; i < 6; i++) mockClient.emit("error", authErr("ECONNRESET"));
    expect(conn.authFailCount).toBe(0);
    expect(conn.authSuspended).toBe(false);
    expect(mockClient.ended).toBe(false);
  });

  test("a timeout error (no code) never counts", () => {
    const conn = makeConn();
    conn.connect();
    for (let i = 0; i < 6; i++) mockClient.emit("error", new Error("keepalive timeout"));
    expect(conn.authSuspended).toBe(false);
  });
});
