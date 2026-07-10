/**
 * Unit tests for mqttPrinterService._findConnectionByUserId — the O(1) dual
 * index (connections by _id + connectionsByUid by bambu_uid) that replaced the
 * per-request linear scan. Verifies both resolution paths and index sync.
 */
const mqttService = require("../services/mqttPrinterService");

function fakeConn(bambuUid) {
  return { bambuUid, printerStates: new Map(), stop() {} };
}

describe("mqttPrinterService._findConnectionByUserId (O(1) index)", () => {
  afterEach(() => {
    mqttService.connections.clear();
    mqttService.connectionsByUid.clear();
  });

  it("resolves a connection by user _id and by bambu_uid", () => {
    const conn = fakeConn("uid-1");
    mqttService.connections.set("id-1", conn);
    mqttService.connectionsByUid.set("uid-1", conn);

    expect(mqttService._findConnectionByUserId("id-1")).toBe(conn);
    expect(mqttService._findConnectionByUserId("uid-1")).toBe(conn);
  });

  it("returns null when neither index holds the key", () => {
    expect(mqttService._findConnectionByUserId("missing")).toBeNull();
  });

  it("coerces non-string ids (ObjectId) to string before lookup", () => {
    const conn = fakeConn("uid-3");
    mqttService.connections.set("507f1f77bcf86cd799439011", conn);
    // Simulate a mongoose ObjectId whose toString() is the hex id.
    const objectIdLike = { toString: () => "507f1f77bcf86cd799439011" };
    expect(mqttService._findConnectionByUserId(objectIdLike)).toBe(conn);
  });

  it("stop() clears BOTH indexes", () => {
    const conn = fakeConn("uid-2");
    mqttService.connections.set("id-2", conn);
    mqttService.connectionsByUid.set("uid-2", conn);

    mqttService.stop();

    expect(mqttService._findConnectionByUserId("id-2")).toBeNull();
    expect(mqttService._findConnectionByUserId("uid-2")).toBeNull();
  });
});
