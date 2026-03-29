/**
 * Tests for MQTT message parsing and state change detection logic.
 * Extracted from PrinterMqttConnection._handlePublish
 */

describe("MQTT message parsing", () => {
  // Simulate the topic matching from _handlePublish
  function parseTopic(topic) {
    const match = topic.match(/^device\/([^/]+)\/report$/);
    return match ? match[1] : null;
  }

  it("extracts device ID from report topic", () => {
    expect(parseTopic("device/03919D571707148/report")).toBe("03919D571707148");
    expect(parseTopic("device/01P00C582701216/report")).toBe("01P00C582701216");
  });

  it("rejects invalid topics", () => {
    expect(parseTopic("device/03919D571707148/request")).toBeNull();
    expect(parseTopic("other/topic")).toBeNull();
    expect(parseTopic("")).toBeNull();
  });
});

describe("MQTT state merging", () => {
  function mergeState(prev, update) {
    const merged = { ...prev };
    for (const key of Object.keys(update)) {
      if (update[key] !== undefined && update[key] !== null) merged[key] = update[key];
    }
    return merged;
  }

  it("merges incremental updates", () => {
    const prev = { gcode_state: "RUNNING", mc_percent: 10, mc_remaining_time: 60 };
    const update = { mc_percent: 15 };
    const merged = mergeState(prev, update);
    expect(merged.mc_percent).toBe(15);
    expect(merged.gcode_state).toBe("RUNNING");
    expect(merged.mc_remaining_time).toBe(60);
  });

  it("does not overwrite with null values", () => {
    const prev = { gcode_state: "RUNNING", mc_percent: 10 };
    const update = { mc_percent: null, gcode_state: "PAUSE" };
    const merged = mergeState(prev, update);
    expect(merged.mc_percent).toBe(10); // preserved
    expect(merged.gcode_state).toBe("PAUSE"); // updated
  });

  it("handles fresh state (no previous)", () => {
    const merged = mergeState({}, { gcode_state: "RUNNING", mc_percent: 0 });
    expect(merged.gcode_state).toBe("RUNNING");
    expect(merged.mc_percent).toBe(0);
  });
});

describe("gcode_state change detection", () => {
  it("detects state change", () => {
    const prev = { gcode_state: "RUNNING" };
    const update = { gcode_state: "PAUSE" };
    const changed = update.gcode_state && update.gcode_state !== prev.gcode_state;
    expect(changed).toBe(true);
  });

  it("ignores same state", () => {
    const prev = { gcode_state: "RUNNING" };
    const update = { gcode_state: "RUNNING" };
    const changed = update.gcode_state && update.gcode_state !== prev.gcode_state;
    expect(changed).toBe(false);
  });

  it("detects change from undefined (first message)", () => {
    const prev = {};
    const update = { gcode_state: "RUNNING" };
    const changed = update.gcode_state && update.gcode_state !== prev.gcode_state;
    expect(changed).toBe(true);
  });
});

describe("progress update throttling", () => {
  it("allows first update", () => {
    const lastUpdate = new Map();
    const now = Date.now();
    const devId = "printer1";
    const last = lastUpdate.get(devId) || 0;
    expect(now - last >= 150000).toBe(true);
  });

  it("blocks update within throttle window", () => {
    const lastUpdate = new Map();
    const devId = "printer1";
    const now = Date.now();
    lastUpdate.set(devId, now);
    expect(now - lastUpdate.get(devId) >= 150000).toBe(false);
  });

  it("allows update after throttle window", () => {
    const lastUpdate = new Map();
    const devId = "printer1";
    lastUpdate.set(devId, Date.now() - 160000); // 160s ago
    expect(Date.now() - lastUpdate.get(devId) >= 150000).toBe(true);
  });
});
