/**
 * Farm Live Activities: cards of up to 4 printers (no "+N" until >20),
 * takeover from 4 printing printers, per-printer cards closed, cards ended
 * when empty, progress pushes throttled.
 */
jest.mock("../services/apnsSender", () => ({
  isConfigured: () => true,
  sendLiveActivityStart: jest.fn(async () => ({ success: true, status: 200 })),
  sendLiveActivityUpdate: jest.fn(async () => ({ success: true, status: 200 })),
  sendLiveActivityEnd: jest.fn(async () => ({ success: true, status: 200 })),
}));
jest.mock("../services/laChannels", () => ({
  openForPrint: jest.fn(async () => null),
  broadcast: jest.fn(async () => null),
  current: jest.fn(async () => null),
}));
const mockFarmDocs = new Map();
jest.mock("../db/models/LaFarmState", () => ({
  findOne: jest.fn((q) => ({ lean: async () => mockFarmDocs.get(q.bambu_uid) || null })),
  updateOne: jest.fn(async (q, u) => { mockFarmDocs.set(q.bambu_uid, { groups: u.groups }); }),
  deleteOne: jest.fn(async (q) => { mockFarmDocs.delete(q.bambu_uid); }),
}));
jest.mock("../services/apnsTokenUtils", () => ({
  getActivityToken: (u, id) => (u.la_activity_tokens || {})[id] || null,
  clearActivityToken: jest.fn(async () => {}),
  clearStartToken: jest.fn(async () => {}),
  isTokenInvalid: () => false,
  isTokenGone: () => false,
}));

const apns = require("../services/apnsSender");
const laChannels = require("../services/laChannels");
const farm = require("../services/laFarm");

const printing = (pct, minLeft) => ({ gcode_state: "RUNNING", mc_percent: pct, mc_remaining_time: minLeft });
function fleet(n) {
  const states = {};
  const names = {};
  for (let i = 1; i <= n; i++) {
    states[`D${i}`] = printing(10 * i, 100 - i);
    names[`D${i}`] = `Printer ${String(i).padStart(2, "0")}`;
  }
  return { states, names };
}
const user = { _id: "u1", bambu_uid: "uid1", la_version: 2, la_push_to_start_token: "start", la_activity_tokens: { D1: "tokD1" } };

beforeEach(() => {
  farm._reset();
  mockFarmDocs.clear();
  jest.clearAllMocks();
});

describe("grouping", () => {
  it("cards of 4, everything listed, no +N up to 20 printers", () => {
    const { states, names } = fleet(7);
    const { groups, overflow } = farm.farmGroups(farm.farmRows(states, names));
    expect(groups.map((g) => g.length)).toEqual([4, 3]);
    expect(overflow).toBe(0);
  });
  it("beyond 5 cards (20 printers) only the overflow is summarized", () => {
    const { states, names } = fleet(23);
    const { groups, overflow } = farm.farmGroups(farm.farmRows(states, names));
    expect(groups).toHaveLength(5);
    expect(overflow).toBe(3);
  });
  it("membership is stable by name; rows inside a card are soonest-first", () => {
    const states = { A: printing(10, 300), B: printing(90, 5), C: printing(50, 60) };
    const names = { A: "Alpha", B: "Bravo", C: "Charlie" };
    const { groups } = farm.farmGroups(farm.farmRows(states, names));
    expect(groups[0].map((r) => r.name)).toEqual(["Bravo", "Charlie", "Alpha"]);
  });
});

describe("takeover", () => {
  it("below the threshold the farm does nothing (per-printer cards as usual)", async () => {
    const { states, names } = fleet(3);
    expect(await farm.handleStart({ bambuUid: "uid1", users: [user], states, names })).toBe(false);
    expect(apns.sendLiveActivityStart).not.toHaveBeenCalled();
  });

  it("from 4 printing: farm cards start and the printer cards are closed", async () => {
    const { states, names } = fleet(6);
    expect(await farm.handleStart({ bambuUid: "uid1", users: [user], states, names })).toBe(true);
    const starts = apns.sendLiveActivityStart.mock.calls.map((c) => c[1]);
    expect(starts).toEqual([
      { printerId: "__farm__", printerName: "Print farm" },
      { printerId: "__farm__2", printerName: "Print farm · 2" },
    ]);
    expect(apns.sendLiveActivityStart.mock.calls[0][2].printers).toHaveLength(4);
    // D1 had a per-printer card: ended immediately
    expect(apns.sendLiveActivityEnd).toHaveBeenCalledWith("tokD1", expect.anything(), 1);
  });

  it("when prints finish, the card that becomes empty is ended", async () => {
    const { states, names } = fleet(6);
    const withFarmTokens = { ...user, la_activity_tokens: { __farm__: "f1", __farm__2: "f2" } };
    await farm.handleStart({ bambuUid: "uid1", users: [withFarmTokens], states, names });
    jest.clearAllMocks();
    for (const k of ["D5", "D6"]) states[k] = { gcode_state: "FINISH", mc_percent: 100 };
    await farm.refresh({ bambuUid: "uid1", users: [withFarmTokens], states, names });
    expect(apns.sendLiveActivityEnd).toHaveBeenCalledWith("f2", expect.objectContaining({ status: "finished" }), 60);
    // Card 1's printers didn't change: no push for it.
    expect(apns.sendLiveActivityUpdate).not.toHaveBeenCalled();
  });

  it("progress ticks are throttled to one push per card every 3 min", async () => {
    const { states, names } = fleet(4);
    const u = { ...user, la_activity_tokens: { __farm__: "f1" } };
    await farm.handleStart({ bambuUid: "uid1", users: [u], states, names });
    jest.clearAllMocks();
    const t0 = Date.now();
    await farm.tick({ bambuUid: "uid1", users: [u], states, names, now: t0 + 60_000 });
    expect(apns.sendLiveActivityUpdate).not.toHaveBeenCalled();
    await farm.tick({ bambuUid: "uid1", users: [u], states, names, now: t0 + 4 * 60_000 });
    expect(apns.sendLiveActivityUpdate).toHaveBeenCalledWith("f1", expect.anything(), 5, expect.anything());
  });

  it("old app builds (no laVersion 2) stay on per-printer cards", async () => {
    const { states, names } = fleet(6);
    const oldApp = { ...user, la_version: null };
    expect(await farm.handleStart({ bambuUid: "uid1", users: [oldApp], states, names })).toBe(false);
    expect(apns.sendLiveActivityStart).not.toHaveBeenCalled();
  });

  it("after a restart, existing farm cards are updated — not started again", async () => {
    mockFarmDocs.set("uid1", { groups: ["__farm__"] });
    const { states, names } = fleet(4);
    const u = { ...user, la_activity_tokens: { __farm__: "f1" } };
    expect(await farm.handleStart({ bambuUid: "uid1", users: [u], states, names })).toBe(true);
    expect(apns.sendLiveActivityStart).not.toHaveBeenCalled();
    expect(apns.sendLiveActivityUpdate).toHaveBeenCalledWith("f1", expect.anything(), 10, expect.anything());
  });

  it("live cards are persisted, and forgotten once the farm ends", async () => {
    const { states, names } = fleet(5);
    await farm.handleStart({ bambuUid: "uid1", users: [user], states, names });
    expect(mockFarmDocs.get("uid1").groups).toEqual(["__farm__", "__farm__2"]);
    for (const k of Object.keys(states)) states[k] = { gcode_state: "FINISH", mc_percent: 100 };
    await farm.refresh({ bambuUid: "uid1", users: [user], states, names });
    expect(mockFarmDocs.has("uid1")).toBe(false);
  });

  it("rows carry the file name, and a paused-only card never goes stale", async () => {
    const states = {
      A: { gcode_state: "PAUSE", mc_percent: 40, mc_remaining_time: 30, subtask_name: "bin.3mf" },
      B: { gcode_state: "PAUSE", mc_percent: 10, mc_remaining_time: 90, subtask_name: "lid.3mf" },
      C: { gcode_state: "PAUSE", mc_percent: 20, mc_remaining_time: 60, subtask_name: "gear.3mf" },
      D: { gcode_state: "PAUSE", mc_percent: 30, mc_remaining_time: 70, subtask_name: "hex.3mf" },
    };
    const names = { A: "A", B: "B", C: "C", D: "D" };
    await farm.handleStart({ bambuUid: "uid1", users: [user], states, names });
    const [, , cs, , opts] = apns.sendLiveActivityStart.mock.calls[0];
    expect(cs.printers.map((r) => r.job)).toEqual(expect.arrayContaining(["bin.3mf", "lid.3mf", "gear.3mf", "hex.3mf"]));
    expect(opts.staleAfterSec).toBe(0);
  });
});
