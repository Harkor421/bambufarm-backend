const {
  isTecnoprintsAccount,
  buildBroadcastMessage,
} = require("../services/tecnoprintsBroadcast");

describe("tecnoprintsBroadcast", () => {
  describe("isTecnoprintsAccount", () => {
    it("returns true for matching UID", () => {
      // Default config UID
      const config = require("../config");
      expect(isTecnoprintsAccount(config.tecnoprints.bambuUid)).toBe(true);
    });

    it("returns false for non-matching UID", () => {
      expect(isTecnoprintsAccount("9999999999")).toBe(false);
    });

    it("returns false for null/undefined", () => {
      expect(isTecnoprintsAccount(null)).toBe(false);
      expect(isTecnoprintsAccount(undefined)).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isTecnoprintsAccount("")).toBe(false);
    });
  });

  describe("buildBroadcastMessage", () => {
    const PRINTER = "P1S-1";
    const JOB = "Benchy.3mf";

    // ─── Ghost-on-boot guard ─────────────────────────────────────────────
    // On backend restart, the first MQTT push for each printer has
    // prevGcodeState=undefined. If any printer is currently in FAILED/PAUSE
    // we MUST NOT broadcast a "just happened" alert for an event that may
    // be days old. Regression test for the "⚠️ P1S-1 failed at 0%" flood.
    it("returns null when prevGcodeState is undefined (boot scenario)", () => {
      expect(buildBroadcastMessage("FAILED", undefined, PRINTER, JOB, 0)).toBeNull();
      expect(buildBroadcastMessage("PAUSE", undefined, PRINTER, JOB, 50)).toBeNull();
      expect(buildBroadcastMessage("RUNNING", undefined, PRINTER, JOB, 30)).toBeNull();
      expect(buildBroadcastMessage("FINISH", undefined, PRINTER, JOB, 100)).toBeNull();
    });

    it("returns null when prevGcodeState is null or empty", () => {
      expect(buildBroadcastMessage("FAILED", null, PRINTER, JOB, 0)).toBeNull();
      expect(buildBroadcastMessage("FAILED", "", PRINTER, JOB, 0)).toBeNull();
    });

    // ─── Failure transitions ─────────────────────────────────────────────
    it("FAILED only fires when previous state was a printing state", () => {
      expect(buildBroadcastMessage("FAILED", "RUNNING", PRINTER, JOB, 42)).toBe(
        "⚠️ P1S-1 failed at 42%: Benchy.3mf"
      );
      expect(buildBroadcastMessage("FAILED", "PAUSE", PRINTER, JOB, 30)).toContain("failed");
      expect(buildBroadcastMessage("FAILED", "PREPARE", PRINTER, JOB, 0)).toContain("failed");
    });

    it("FAILED → FAILED or IDLE → FAILED does NOT fire (printer was already failed)", () => {
      expect(buildBroadcastMessage("FAILED", "FAILED", PRINTER, JOB, 0)).toBeNull();
      expect(buildBroadcastMessage("FAILED", "IDLE", PRINTER, JOB, 0)).toBeNull();
      expect(buildBroadcastMessage("FAILED", "FINISH", PRINTER, JOB, 0)).toBeNull();
    });

    // ─── Other transitions sanity checks ─────────────────────────────────
    it("emits start message when RUNNING from a terminal state", () => {
      expect(buildBroadcastMessage("RUNNING", "IDLE", PRINTER, JOB, 0)).toContain("started");
      expect(buildBroadcastMessage("RUNNING", "FINISH", PRINTER, JOB, 0)).toContain("started");
    });

    it("emits pause/resume", () => {
      expect(buildBroadcastMessage("PAUSE", "RUNNING", PRINTER, JOB, 50)).toContain("paused");
      expect(buildBroadcastMessage("RUNNING", "PAUSE", PRINTER, JOB, 50)).toContain("resumed");
    });

    it("classifies finish vs cancel by progress", () => {
      expect(buildBroadcastMessage("FINISH", "RUNNING", PRINTER, JOB, 100)).toContain("finished");
      expect(buildBroadcastMessage("FINISH", "RUNNING", PRINTER, JOB, 25)).toContain("cancelled");
      expect(buildBroadcastMessage("IDLE", "RUNNING", PRINTER, JOB, 50)).toContain("cancelled");
    });
  });
});
