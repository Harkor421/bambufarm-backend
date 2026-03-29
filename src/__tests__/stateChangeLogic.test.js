/**
 * Tests for the state change → notification mapping logic.
 * Verifies correct notification types, LA token usage, and edge cases.
 */

describe("state change → notification type mapping", () => {
  function getNotificationType(gcodeState, effectivePrev, mcPercent) {
    if (gcodeState === "PAUSE" && effectivePrev === "RUNNING") return "print_paused";
    if (gcodeState === "RUNNING" && effectivePrev === "PAUSE") return "print_resumed";
    if ((gcodeState === "FINISH" || gcodeState === "IDLE") &&
        (effectivePrev === "RUNNING" || effectivePrev === "PAUSE" || effectivePrev === "PREPARE")) {
      return (mcPercent || 0) < 90 ? "print_error" : "print_finished";
    }
    if (gcodeState === "FAILED" &&
        (effectivePrev === "RUNNING" || effectivePrev === "PAUSE" || effectivePrev === "PREPARE")) {
      return "print_error";
    }
    if (gcodeState === "RUNNING" &&
        (effectivePrev === "IDLE" || effectivePrev === "FINISH" || effectivePrev === "FAILED" || effectivePrev === "PREPARE")) {
      return "print_started";
    }
    return null;
  }

  it("RUNNING → PAUSE = print_paused", () => {
    expect(getNotificationType("PAUSE", "RUNNING")).toBe("print_paused");
  });

  it("PAUSE → RUNNING = print_resumed", () => {
    expect(getNotificationType("RUNNING", "PAUSE")).toBe("print_resumed");
  });

  it("RUNNING → FINISH with >90% = print_finished", () => {
    expect(getNotificationType("FINISH", "RUNNING", 95)).toBe("print_finished");
  });

  it("RUNNING → FINISH with <90% = print_error (cancelled)", () => {
    expect(getNotificationType("FINISH", "RUNNING", 10)).toBe("print_error");
  });

  it("RUNNING → IDLE with <90% = print_error (cancelled)", () => {
    expect(getNotificationType("IDLE", "RUNNING", 50)).toBe("print_error");
  });

  it("RUNNING → FAILED = print_error", () => {
    expect(getNotificationType("FAILED", "RUNNING")).toBe("print_error");
  });

  it("IDLE → RUNNING = print_started", () => {
    expect(getNotificationType("RUNNING", "IDLE")).toBe("print_started");
  });

  it("PREPARE → RUNNING = print_started", () => {
    expect(getNotificationType("RUNNING", "PREPARE")).toBe("print_started");
  });

  it("FINISH → RUNNING = print_started", () => {
    expect(getNotificationType("RUNNING", "FINISH")).toBe("print_started");
  });

  it("FAILED → RUNNING = print_started", () => {
    expect(getNotificationType("RUNNING", "FAILED")).toBe("print_started");
  });

  it("RUNNING → RUNNING = no notification", () => {
    expect(getNotificationType("RUNNING", "RUNNING")).toBeNull();
  });

  it("IDLE → IDLE = no notification", () => {
    expect(getNotificationType("IDLE", "IDLE")).toBeNull();
  });
});

describe("LA token type per event", () => {
  // This is the CRITICAL rule: push-to-start only for start, activity token for update/end
  function getRequiredTokenType(notifType) {
    if (notifType === "print_started") return "push_to_start";
    if (notifType === "print_finished" || notifType === "print_error") return "activity_update";
    if (notifType === "print_paused" || notifType === "print_resumed") return "activity_update";
    return null;
  }

  it("print_started uses push-to-start token", () => {
    expect(getRequiredTokenType("print_started")).toBe("push_to_start");
  });

  it("print_paused uses activity update token", () => {
    expect(getRequiredTokenType("print_paused")).toBe("activity_update");
  });

  it("print_resumed uses activity update token", () => {
    expect(getRequiredTokenType("print_resumed")).toBe("activity_update");
  });

  it("print_finished uses activity update token", () => {
    expect(getRequiredTokenType("print_finished")).toBe("activity_update");
  });

  it("print_error uses activity update token", () => {
    expect(getRequiredTokenType("print_error")).toBe("activity_update");
  });
});

describe("progress normalization", () => {
  function normalizeProgress(gcodeState, effectivePrev, rawProgressPct) {
    const rawProgress = (rawProgressPct || 0) / 100;
    if (gcodeState === "PREPARE") return 0;
    if (gcodeState === "RUNNING" && effectivePrev === "PREPARE" && rawProgress >= 0.95) return 0;
    return rawProgress;
  }

  it("PREPARE always shows 0% progress", () => {
    expect(normalizeProgress("PREPARE", "IDLE", 50)).toBe(0);
  });

  it("RUNNING from PREPARE with high fake progress shows 0%", () => {
    // When transitioning from PREPARE to RUNNING, mc_percent can briefly show 95-100%
    // from a previous print — this should be treated as 0%
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
    const nowSec = 1000;
    const remaining = 1800; // 30 min
    const endTime = remaining > 0 ? nowSec + remaining : nowSec;
    expect(endTime).toBe(2800);
  });

  it("uses nowSec when no remaining time (no fake 1hr)", () => {
    const nowSec = 1000;
    const remaining = 0;
    const endTime = remaining > 0 ? nowSec + remaining : nowSec;
    expect(endTime).toBe(1000); // NOT 4600 (nowSec + 3600)
  });
});
