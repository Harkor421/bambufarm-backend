/**
 * Cameras stream only while someone is watching: no "always stream printing
 * printers", backgrounded apps don't count, stale frames aren't "now".
 */
const wsManager = require("../services/wsManager");
const config = require("../config");

const UID = "uidCam";

function appSocket({ subscribed = [], lastPingAgoMs = 1000 } = {}) {
  const ws = { readyState: 1, _lastClientPingAt: Date.now() - lastPingAgoMs, send() {} };
  wsManager.appMeta.set(ws, { userId: UID, subscribedPrinters: new Set(subscribed) });
  return ws;
}

describe("camera demand", () => {
  beforeEach(() => {
    wsManager.appClients.delete(UID);
    wsManager._adminCameraDemandUntil = 0;
    wsManager.setPrinterStateGetter?.(() => ({
      P1: { gcode_state: "RUNNING" },
      P2: { gcode_state: "IDLE" },
    }));
    if (!wsManager.setPrinterStateGetter) {
      wsManager._printerStateGetter = () => ({ P1: { gcode_state: "RUNNING" }, P2: { gcode_state: "IDLE" } });
    }
  });

  it("a printing printer with nobody watching is NOT demanded", () => {
    expect([...wsManager._getDemandedPrinters(UID)]).toEqual([]);
  });

  it("a foreground app watching a printer demands exactly that printer", () => {
    wsManager.appClients.set(UID, new Set([appSocket({ subscribed: ["P2"] })]));
    expect([...wsManager._getDemandedPrinters(UID)]).toEqual(["P2"]);
  });

  it("a backgrounded app (no ping past the idle threshold) does not keep cameras on", () => {
    const idle = appSocket({ subscribed: ["P1"], lastPingAgoMs: config.ws.appIdleThresholdMs + 5000 });
    wsManager.appClients.set(UID, new Set([idle]));
    expect([...wsManager._getDemandedPrinters(UID)]).toEqual([]);
  });

  it("the admin cameras tab demands every known printer while open", () => {
    wsManager._adminCameraDemandUntil = Date.now() + 60000;
    expect([...wsManager._getDemandedPrinters(UID)].sort()).toEqual(["P1", "P2"]);
  });
});

describe("getLatestFrame freshness", () => {
  it("returns the frame without maxAge, but not when it is older than maxAge", () => {
    const frame = Buffer.alloc(200, 1);
    wsManager.latestFrames.set(UID, new Map([["P1", frame]]));
    wsManager._frameAt.set(frame, Date.now() - 5 * 60 * 1000);
    expect(wsManager.getLatestFrame(UID, "P1")).toBe(frame);
    expect(wsManager.getLatestFrame(UID, "P1", 90 * 1000)).toBeNull();
    wsManager._frameAt.set(frame, Date.now() - 10 * 1000);
    expect(wsManager.getLatestFrame(UID, "P1", 90 * 1000)).toBe(frame);
  });
});
