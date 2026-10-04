/**
 * Live Activity progress cadence + one-card-per-print guard.
 *
 *  · 20% milestones go at priority 10 (the proven path, budgeted by Apple).
 *  · Between milestones: priority 5 when progress moved ≥1% and ≥3 min passed,
 *    or a 10-min heartbeat when the remaining time was re-estimated.
 *  · A pause/resume with no update token must NOT push-to-start a second card
 *    for a print we already started one for (it used to stack cards).
 *  · A 410 on a push-to-start token deletes that token.
 */
jest.mock("../services/apnsSender", () => ({
  isConfigured: () => true,
  sendLiveActivityStart: jest.fn(async () => ({ success: true, status: 200 })),
  sendLiveActivityUpdate: jest.fn(async () => ({ success: true, status: 200 })),
  sendLiveActivityEnd: jest.fn(async () => ({ success: true, status: 200 })),
}));
jest.mock("../services/apnsTokenUtils", () => ({
  getActivityToken: (u, devId) => (u.la_activity_tokens || {})[devId] || null,
  clearActivityToken: jest.fn(async () => {}),
  clearStartToken: jest.fn(async () => {}),
  isTokenInvalid: (r) => !!r && (r.status === 410 || (r.status === 400 && r.reason?.reason === "BadDeviceToken")),
  isTokenGone: (r) => !!r && r.status === 410,
}));

const apns = require("../services/apnsSender");
const tokenUtils = require("../services/apnsTokenUtils");
const ledger = require("../services/laStartLedger");
const { dispatchLiveActivity } = require("../services/liveActivityDispatcher");
const PrinterMqttConnection = require("../services/mqttPrinterConnection");

const DEV = "01P00CTEST0001";

describe("progress cadence", () => {
  let calls;
  let conn;
  let now;
  const realNow = Date.now;

  beforeEach(() => {
    calls = [];
    now = 1_000_000_000_000;
    Date.now = () => now;
    conn = new PrinterMqttConnection({
      userId: "u1",
      bambuUid: "uid1",
      accessToken: "tok",
      printerIds: new Set([DEV]),
      onStateChange: async () => {},
      onProgressUpdate: async (devId, state, priority) => calls.push({ pct: state.mc_percent, priority }),
      onOffline: () => {},
    });
  });
  afterEach(() => {
    Date.now = realNow;
  });

  const report = (print) =>
    conn._handlePublish(`device/${DEV}/report`, Buffer.from(JSON.stringify({ print })));
  const advance = (min) => {
    now += min * 60 * 1000;
  };

  it("first report of a print is a priority-10 push", async () => {
    await report({ gcode_state: "RUNNING", mc_percent: 3, mc_remaining_time: 300 });
    expect(calls).toEqual([{ pct: 3, priority: 10 }]);
  });

  it("sends priority-5 ticks between milestones, at most every 3 min and only on ≥1% moves", async () => {
    await report({ gcode_state: "RUNNING", mc_percent: 3, mc_remaining_time: 300 });
    advance(1);
    await report({ mc_percent: 5 }); // moved but <3 min → nothing
    advance(2.5);
    await report({ mc_percent: 6 }); // 3.5 min, moved → p5
    advance(3);
    await report({ mc_percent: 6 }); // no move, <10 min → nothing
    expect(calls.map((c) => c.priority)).toEqual([10, 5]);
  });

  it("crossing a 20% boundary is always priority 10, even right after a tick", async () => {
    await report({ gcode_state: "RUNNING", mc_percent: 18, mc_remaining_time: 100 });
    advance(0.5);
    await report({ mc_percent: 20 });
    expect(calls.map((c) => c.priority)).toEqual([10, 10]);
  });

  it("10-min heartbeat refreshes a re-estimated remaining time even without % movement", async () => {
    await report({ gcode_state: "RUNNING", mc_percent: 50, mc_remaining_time: 600 });
    advance(11);
    await report({ mc_percent: 50, mc_remaining_time: 640 });
    expect(calls.map((c) => c.priority)).toEqual([10, 5]);
  });

  it("resets when the print ends, so the next print starts with a priority-10 push", async () => {
    await report({ gcode_state: "RUNNING", mc_percent: 99, mc_remaining_time: 1 });
    await report({ gcode_state: "FINISH", mc_percent: 100 });
    await report({ gcode_state: "RUNNING", mc_percent: 1, mc_remaining_time: 200 });
    expect(calls.map((c) => c.priority)).toEqual([10, 10]);
  });
});

describe("one card per print (dispatcher)", () => {
  const user = { _id: "u1", bambu_uid: "uid1", la_push_to_start_token: "start-tok", la_activity_tokens: {} };
  const state = { gcode_state: "PAUSE", subtask_name: "bin.3mf", task_id: "777", mc_percent: 40, mc_remaining_time: 60 };

  beforeEach(() => {
    ledger._reset();
    jest.clearAllMocks();
  });

  it("print_started records the card; a later pause without token does NOT start another", async () => {
    await dispatchLiveActivity([user], DEV, { data: { type: "print_started" } }, { ...state, gcode_state: "RUNNING" }, "RUNNING", "IDLE", "P1S");
    expect(apns.sendLiveActivityStart).toHaveBeenCalledTimes(1);

    await dispatchLiveActivity([user], DEV, { data: { type: "print_paused" } }, state, "PAUSE", "RUNNING", "P1S");
    await dispatchLiveActivity([user], DEV, { data: { type: "print_resumed" } }, { ...state, gcode_state: "RUNNING" }, "RUNNING", "PAUSE", "P1S");
    expect(apns.sendLiveActivityStart).toHaveBeenCalledTimes(1);
  });

  it("a pause on a print we never started a card for still gets ONE fallback card", async () => {
    await dispatchLiveActivity([user], DEV, { data: { type: "print_paused" } }, state, "PAUSE", "RUNNING", "P1S");
    await dispatchLiveActivity([user], DEV, { data: { type: "print_resumed" } }, { ...state, gcode_state: "RUNNING" }, "RUNNING", "PAUSE", "P1S");
    expect(apns.sendLiveActivityStart).toHaveBeenCalledTimes(1);
  });

  it("a NEW print on the same printer gets its own card", async () => {
    await dispatchLiveActivity([user], DEV, { data: { type: "print_started" } }, { ...state, gcode_state: "RUNNING" }, "RUNNING", "IDLE", "P1S");
    await dispatchLiveActivity([user], DEV, { data: { type: "print_finished" } }, { ...state, gcode_state: "FINISH" }, "FINISH", "RUNNING", "P1S");
    await dispatchLiveActivity([user], DEV, { data: { type: "print_started" } }, { ...state, task_id: "778", gcode_state: "RUNNING" }, "RUNNING", "IDLE", "P1S");
    expect(apns.sendLiveActivityStart).toHaveBeenCalledTimes(2);
  });

  it("deletes a push-to-start token Apple answers 410 for", async () => {
    apns.sendLiveActivityStart.mockResolvedValueOnce({ success: false, status: 410, reason: { reason: "Unregistered" } });
    await dispatchLiveActivity([user], DEV, { data: { type: "print_started" } }, { ...state, gcode_state: "RUNNING" }, "RUNNING", "IDLE", "P1S");
    expect(tokenUtils.clearStartToken).toHaveBeenCalledWith("u1", "start-tok");
  });

  it("does NOT delete a start token on BadDeviceToken (config problem, not a dead token)", async () => {
    apns.sendLiveActivityStart.mockResolvedValueOnce({ success: false, status: 400, reason: { reason: "BadDeviceToken" } });
    await dispatchLiveActivity([user], DEV, { data: { type: "print_started" } }, { ...state, gcode_state: "RUNNING" }, "RUNNING", "IDLE", "P1S");
    expect(tokenUtils.clearStartToken).not.toHaveBeenCalled();
  });

  it("updates a card that HAS a token, with a stale-date while printing", async () => {
    const withTok = { ...user, la_activity_tokens: { [DEV]: "act-tok" } };
    await dispatchLiveActivity([withTok], DEV, { data: { type: "print_resumed" } }, { ...state, gcode_state: "RUNNING" }, "RUNNING", "PAUSE", "P1S");
    expect(apns.sendLiveActivityUpdate).toHaveBeenCalledWith("act-tok", expect.objectContaining({ status: "printing" }), 10, { staleAfterSec: 1800 });
    expect(apns.sendLiveActivityStart).not.toHaveBeenCalled();
  });
});
