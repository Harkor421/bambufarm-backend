/**
 * Tests for the notification builder — state change → notification mapping.
 * Now tests the REAL buildNotification function (not a re-implementation).
 */

const { buildNotification, normalizeProgress } = require("../services/notificationBuilder");

// Helper: build with minimal state
function build(gcodeState, effectivePrev, overrides = {}) {
  const state = { mc_percent: 50, mc_remaining_time: 30, subtask_name: "Benchy.3mf", hms: [], ...overrides };
  return buildNotification(gcodeState, effectivePrev, state, "PRINTER001", "Test Printer");
}

describe("buildNotification — state change → notification type", () => {
  it("RUNNING → PAUSE = print_paused", () => {
    const n = build("PAUSE", "RUNNING");
    expect(n.data.type).toBe("print_paused");
    expect(n.title).toContain("paused");
  });

  it("PAUSE → RUNNING = print_resumed", () => {
    const n = build("RUNNING", "PAUSE");
    expect(n.data.type).toBe("print_resumed");
    expect(n.title).toContain("resumed");
  });

  it("RUNNING → FINISH with >90% = print_finished", () => {
    const n = build("FINISH", "RUNNING", { mc_percent: 95 });
    expect(n.data.type).toBe("print_finished");
    expect(n.title).toContain("finished");
  });

  it("RUNNING → FINISH with <90% = print_error (cancelled)", () => {
    const n = build("FINISH", "RUNNING", { mc_percent: 10 });
    expect(n.data.type).toBe("print_error");
    expect(n.title).toContain("cancelled");
  });

  it("RUNNING → IDLE with <90% = print_error (cancelled)", () => {
    const n = build("IDLE", "RUNNING", { mc_percent: 50 });
    expect(n.data.type).toBe("print_error");
  });

  it("RUNNING → FAILED = print_error", () => {
    const n = build("FAILED", "RUNNING");
    expect(n.data.type).toBe("print_error");
    expect(n.title).toContain("failed");
  });

  it("IDLE → RUNNING = print_started", () => {
    const n = build("RUNNING", "IDLE");
    expect(n.data.type).toBe("print_started");
    expect(n.title).toContain("started");
  });

  it("PREPARE → RUNNING = print_started", () => {
    const n = build("RUNNING", "PREPARE");
    expect(n.data.type).toBe("print_started");
  });

  it("FINISH → RUNNING = print_started", () => {
    const n = build("RUNNING", "FINISH");
    expect(n.data.type).toBe("print_started");
  });

  it("FAILED → RUNNING = print_started", () => {
    const n = build("RUNNING", "FAILED");
    expect(n.data.type).toBe("print_started");
  });

  it("RUNNING → RUNNING = no notification", () => {
    expect(build("RUNNING", "RUNNING")).toBeNull();
  });

  it("IDLE → IDLE = no notification", () => {
    expect(build("IDLE", "IDLE")).toBeNull();
  });
});

describe("buildNotification — notification content", () => {
  it("includes printer name in title", () => {
    const n = build("PAUSE", "RUNNING");
    expect(n.title).toContain("Test Printer");
  });

  it("includes device ID in data", () => {
    const n = build("PAUSE", "RUNNING");
    expect(n.data.printerId).toBe("PRINTER001");
  });

  it("includes progress in paused notification", () => {
    const n = build("PAUSE", "RUNNING", { mc_percent: 45 });
    expect(n.data.progressPct).toBe(45);
  });

  it("includes remaining time in resumed notification", () => {
    const n = build("RUNNING", "PAUSE", { mc_remaining_time: 60 });
    expect(n.data.remainingSec).toBe(3600);
  });

  it("includes job title in body", () => {
    const n = build("RUNNING", "IDLE", { subtask_name: "Dragon.3mf" });
    expect(n.body).toBe("Dragon.3mf");
  });

  it("pause with HMS alerts shows error description", () => {
    // HMS ecode 0300120000020001 → "The front cover of the toolhead fell off."
    // attr = 0x03001200, code = 0x00020001
    const n = build("PAUSE", "RUNNING", { hms: [{ attr: 0x03001200, code: 0x00020001 }] });
    expect(n.body).toContain("front cover");
  });

  it("pause without HMS shows 'Paused by user'", () => {
    const n = build("PAUSE", "RUNNING", { hms: [] });
    expect(n.body).toBe("Paused by user");
  });

  it("failed with HMS shows error description", () => {
    // HMS ecode 03001A0000020002 → "The nozzle is clogged with filament."
    // attr = 0x03001A00, code = 0x00020002
    const n = build("FAILED", "RUNNING", { hms: [{ attr: 0x03001A00, code: 0x00020002 }] });
    expect(n.body).toContain("clogged");
  });
});

describe("buildNotification — LA token type per event", () => {
  it("print_started uses push-to-start token (implicit)", () => {
    const n = build("RUNNING", "IDLE");
    expect(n.data.type).toBe("print_started");
  });

  it("print_paused uses activity update token (implicit)", () => {
    const n = build("PAUSE", "RUNNING");
    expect(n.data.type).toBe("print_paused");
  });

  it("print_finished uses activity update token (implicit)", () => {
    const n = build("FINISH", "RUNNING", { mc_percent: 100 });
    expect(n.data.type).toBe("print_finished");
  });

  it("print_error uses activity update token (implicit)", () => {
    const n = build("FAILED", "RUNNING");
    expect(n.data.type).toBe("print_error");
  });
});

describe("normalizeProgress", () => {
  it("PREPARE always shows 0% progress", () => {
    expect(normalizeProgress("PREPARE", "IDLE", 50)).toBe(0);
  });

  it("RUNNING from PREPARE with high fake progress shows 0%", () => {
    expect(normalizeProgress("RUNNING", "PREPARE", 98)).toBe(0);
  });

  it("RUNNING from PREPARE with real low progress shows actual", () => {
    expect(normalizeProgress("RUNNING", "PREPARE", 5)).toBeCloseTo(0.05);
  });

  it("normal RUNNING shows actual progress", () => {
    expect(normalizeProgress("RUNNING", "RUNNING", 50)).toBeCloseTo(0.5);
  });

  it("handles null/zero percent", () => {
    expect(normalizeProgress("RUNNING", "IDLE", null)).toBe(0);
    expect(normalizeProgress("RUNNING", "IDLE", 0)).toBe(0);
  });
});

describe("endTime calculation", () => {
  it("uses remaining time when available", () => {
    const n = build("RUNNING", "IDLE", { mc_remaining_time: 30 });
    expect(n.data.remainingSec).toBe(1800);
  });

  it("uses 0 when no remaining time", () => {
    const n = build("RUNNING", "IDLE", { mc_remaining_time: 0 });
    expect(n.data.remainingSec).toBe(0);
  });
});
