const { classifyEvent } = require("../services/trainingDataCapture");

describe("trainingDataCapture classifyEvent", () => {
  it("RUNNING → FINISH with high progress = successful_prints/finish", () => {
    const r = classifyEvent("FINISH", "RUNNING", { mc_percent: 98 });
    expect(r).toEqual({ folder: "successful_prints", event: "finish" });
  });

  it("RUNNING → FINISH with low progress = failed_prints/cancelled", () => {
    const r = classifyEvent("FINISH", "RUNNING", { mc_percent: 15 });
    expect(r).toEqual({ folder: "failed_prints", event: "cancelled" });
  });

  it("PAUSE → FINISH (high) = successful_prints/finish", () => {
    const r = classifyEvent("FINISH", "PAUSE", { mc_percent: 100 });
    expect(r).toEqual({ folder: "successful_prints", event: "finish" });
  });

  it("RUNNING → FAILED = failed_prints/failed", () => {
    const r = classifyEvent("FAILED", "RUNNING", { mc_percent: 40 });
    expect(r).toEqual({ folder: "failed_prints", event: "failed" });
  });

  it("PREPARE → FAILED = failed_prints/failed", () => {
    const r = classifyEvent("FAILED", "PREPARE", { mc_percent: 0 });
    expect(r).toEqual({ folder: "failed_prints", event: "failed" });
  });

  it("RUNNING → PAUSE = failed_prints/paused", () => {
    const r = classifyEvent("PAUSE", "RUNNING", { mc_percent: 50 });
    expect(r).toEqual({ folder: "failed_prints", event: "paused" });
  });

  it("RUNNING → IDLE with low progress = failed_prints/cancelled", () => {
    const r = classifyEvent("IDLE", "RUNNING", { mc_percent: 20 });
    expect(r).toEqual({ folder: "failed_prints", event: "cancelled" });
  });

  it("RUNNING → IDLE with high progress = not captured (handled via FINISH)", () => {
    expect(classifyEvent("IDLE", "RUNNING", { mc_percent: 95 })).toBeNull();
  });

  it("IDLE → RUNNING (print start) = not captured", () => {
    expect(classifyEvent("RUNNING", "IDLE", { mc_percent: 0 })).toBeNull();
  });

  it("PAUSE → RUNNING (resume) = not captured", () => {
    expect(classifyEvent("RUNNING", "PAUSE", { mc_percent: 50 })).toBeNull();
  });

  it("PREPARE → RUNNING = not captured", () => {
    expect(classifyEvent("RUNNING", "PREPARE", { mc_percent: 2 })).toBeNull();
  });

  it("handles missing mc_percent", () => {
    const r = classifyEvent("FAILED", "RUNNING", {});
    expect(r).toEqual({ folder: "failed_prints", event: "failed" });
  });
});
