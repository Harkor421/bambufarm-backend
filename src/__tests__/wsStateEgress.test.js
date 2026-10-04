/**
 * WS printer_state egress: identical states are not re-sent, delta-capable
 * clients get only changed fields, and legacy clients still get full states.
 */
const wsManager = require("../services/wsManager");
const egressMeter = require("../services/egressMeter");

function sock({ delta = false } = {}) {
  return { readyState: 1, _delta: delta, sent: [], send(m) { this.sent.push(JSON.parse(m)); } };
}

const BASE = {
  gcodeState: "RUNNING", percent: 10, remainingMin: 90, nozzleTemp: 220, bedTemp: 60,
  ams: { units: [{ id: "0", trays: [{ id: "0", color: "FF0000FF", type: "PLA" }] }], virtualTray: null, trayNow: "0" },
};

describe("broadcastMqttState", () => {
  let legacy, delta;
  beforeEach(() => {
    wsManager._lastStateJson.clear();
    legacy = sock();
    delta = sock({ delta: true });
    wsManager.appClients.set("uidX", new Set([legacy, delta]));
  });
  afterEach(() => wsManager.appClients.delete("uidX"));

  it("first broadcast: both get the full state", () => {
    wsManager.broadcastMqttState("uidX", "DEV1", BASE);
    expect(legacy.sent[0].state).toEqual(BASE);
    expect(delta.sent[0].state).toEqual(BASE);
  });

  it("an identical state is not re-sent to anyone", () => {
    wsManager.broadcastMqttState("uidX", "DEV1", BASE);
    wsManager.broadcastMqttState("uidX", "DEV1", { ...BASE });
    expect(legacy.sent).toHaveLength(1);
    expect(delta.sent).toHaveLength(1);
  });

  it("a change: legacy gets the full state, delta gets only the changed fields (no AMS)", () => {
    wsManager.broadcastMqttState("uidX", "DEV1", BASE);
    wsManager.broadcastMqttState("uidX", "DEV1", { ...BASE, percent: 11, nozzleTemp: 221 });
    expect(legacy.sent[1].state).toEqual({ ...BASE, percent: 11, nozzleTemp: 221 });
    expect(delta.sent[1].state).toEqual({ percent: 11, nozzleTemp: 221 });
  });

  it("merging the deltas reproduces the full state (what the app reducer does)", () => {
    const states = [BASE, { ...BASE, percent: 12 }, { ...BASE, percent: 12, gcodeState: "PAUSE" }];
    let merged = {};
    for (const st of states) {
      wsManager.broadcastMqttState("uidX", "DEV1", st);
    }
    for (const m of delta.sent) merged = { ...merged, ...m.state };
    expect(merged).toEqual(states[2]);
  });

  it("a field going to null travels as null in a delta", () => {
    wsManager.broadcastMqttState("uidX", "DEV1", BASE);
    wsManager.broadcastMqttState("uidX", "DEV1", { ...BASE, ams: null });
    expect(delta.sent[1].state).toEqual({ ams: null });
  });
});

describe("egressMeter", () => {
  beforeEach(() => egressMeter._reset());
  it("attributes bytes to categories", () => {
    egressMeter.add("ws:app:printer_state", 1000);
    egressMeter.add("http:/api/health", 250);
    const snap = egressMeter.snapshot();
    expect(snap.totalBytes).toBe(1250);
    expect(snap.categories[0]).toMatchObject({ category: "ws:app:printer_state", bytes: 1000, messages: 1 });
  });
  it("meterSocket counts sends without changing them", () => {
    const sent = [];
    const ws = { send: (d) => sent.push(d) };
    egressMeter.meterSocket(ws, "ws:test");
    ws.send("hello");
    expect(sent).toEqual(["hello"]);
    expect(egressMeter.snapshot().categories[0]).toMatchObject({ category: "ws:test", bytes: 5 });
  });
});
