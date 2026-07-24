/**
 * Regression guard for the printerStates RAM prune (dropping known-heavy unused
 * top-level Bambu `print` fields from the cached state). Exercises the REAL
 * _handlePublish merge path to prove:
 *   1. the drop-fields never survive in the cache, and
 *   2. the prune does NOT disturb the incremental-merge carry-forward — the
 *      only merge base is `ams`, and a partial AMS report must still preserve
 *      every other unit/tray (the exact bug the deep-merge exists to prevent).
 */
const PrinterMqttConnection = require("../services/mqttPrinterConnection");
const { normalizeMqttState } = require("../utils/normalizeMqttState");

const DEV = "01P00CTEST0001";
const DROP_FIELDS = [
  "stg", "ipcam", "xcam", "net", "upload", "online", "hw_switch_state",
  "home_flag", "mc_print_stage", "cooling_fan_speed", "big_fan1_speed",
  "big_fan2_speed", "heatbreak_fan_speed", "fan_gear",
];

function makeConn() {
  return new PrinterMqttConnection({
    userId: "u1",
    bambuUid: "uid1",
    accessToken: "tok",
    printerIds: new Set([DEV]),
    onStateChange: async () => {},
    onProgressUpdate: async () => {},
    onOffline: () => {},
  });
}

function report(conn, print) {
  return conn._handlePublish(`device/${DEV}/report`, Buffer.from(JSON.stringify({ print })));
}

const FULL_PUSHALL = {
  gcode_state: "RUNNING",
  mc_percent: 42,
  mc_remaining_time: 120,
  stg_cur: 2, // KEEP — returned as `stage`; must NOT be confused with dropped `stg`
  nozzle_temper: 220,
  bed_temper: 60,
  subtask_name: "test.gcode",
  // Heavy top-level fields we drop:
  stg: [1, 2, 3],
  ipcam: { ipcam_dev: "1", ipcam_record: "enable", resolution: "1080p" },
  xcam: { allow_skip_parts: false },
  net: { conf: 16, info: [{ ip: 123, mask: 0 }] },
  upload: { status: "idle", progress: 0 },
  online: { ahb: false, rfid: false },
  hw_switch_state: 1,
  home_flag: 1023,
  mc_print_stage: "2",
  cooling_fan_speed: "15",
  big_fan1_speed: "0",
  big_fan2_speed: "0",
  heatbreak_fan_speed: "0",
  fan_gear: 0,
  // The one recursively-merged structure — must survive intact:
  ams: {
    tray_now: "0",
    ams: [
      { id: "0", humidity: "5", temp: "25", tray: [
        { id: "0", tray_color: "FF0000FF", tray_type: "PLA" },
        { id: "1", tray_color: "00FF00FF", tray_type: "PETG" },
      ] },
      { id: "1", humidity: "4", temp: "26", tray: [
        { id: "0", tray_color: "0000FFFF", tray_type: "ABS" },
      ] },
    ],
  },
};

describe("printerStates prune", () => {
  it("drops every heavy unused top-level field but keeps everything read", async () => {
    const conn = makeConn();
    await report(conn, FULL_PUSHALL);
    const state = conn.printerStates.get(DEV);

    for (const f of DROP_FIELDS) {
      expect(state[f]).toBeUndefined();
    }
    // Kept scalars survive
    expect(state.gcode_state).toBe("RUNNING");
    expect(state.mc_percent).toBe(42);
    expect(state.stg_cur).toBe(2); // NOT dropped alongside `stg`
    expect(state.nozzle_temper).toBe(220);
    // AMS survives fully
    expect(state.ams.ams).toHaveLength(2);
    expect(state.ams.ams[0].tray).toHaveLength(2);
  });

  it("preserves the AMS carry-forward across a partial report (merge base intact)", async () => {
    const conn = makeConn();
    await report(conn, FULL_PUSHALL);

    // Bambu replies to an AMS change with ONLY the changed unit/tray.
    await report(conn, {
      ams: { ams: [{ id: "0", tray: [{ id: "1", tray_color: "FFFF00FF" }] }] },
    });

    const ams = conn.printerStates.get(DEV).ams.ams;
    const unit0 = ams.find((u) => u.id === "0");
    const unit1 = ams.find((u) => u.id === "1");

    // Unit 1 (untouched) fully preserved
    expect(unit1).toBeDefined();
    expect(unit1.tray[0].tray_type).toBe("ABS");
    // Unit 0 tray 0 (untouched) preserved
    expect(unit0.tray.find((t) => t.id === "0").tray_color).toBe("FF0000FF");
    // Unit 0 tray 1 updated but its unmentioned field (tray_type) carried forward
    const t1 = unit0.tray.find((t) => t.id === "1");
    expect(t1.tray_color).toBe("FFFF00FF");
    expect(t1.tray_type).toBe("PETG");
  });

  it("normalizeMqttState output is unaffected by the prune", async () => {
    const conn = makeConn();
    await report(conn, FULL_PUSHALL);
    const out = normalizeMqttState(conn.printerStates.get(DEV));
    expect(out.gcodeState).toBe("RUNNING");
    expect(out.stage).toBe(2); // derived from stg_cur, which we kept
    expect(out.ams).toBeTruthy();
  });
});
