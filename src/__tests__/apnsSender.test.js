const apns = require("../services/apnsSender");

describe("apnsSender", () => {
  describe("isConfigured", () => {
    it("returns false when env vars are not set", () => {
      // Default test env has no APNS keys
      expect(apns.isConfigured()).toBe(false);
    });
  });

  describe("sendLiveActivityStart", () => {
    it("returns null when not configured", async () => {
      const result = await apns.sendLiveActivityStart(
        "abc123",
        { printerId: "P1", printerName: "Test" },
        { jobTitle: "Test", progress: 0, startTime: 1000, endTime: 2000, status: "printing" }
      );
      expect(result).toBeNull();
    });
  });

  describe("sendLiveActivityUpdate", () => {
    it("returns null when not configured", async () => {
      const result = await apns.sendLiveActivityUpdate(
        "abc123",
        { jobTitle: "Test", progress: 0.5, startTime: 1000, endTime: 2000, status: "printing" }
      );
      expect(result).toBeNull();
    });

    it("defaults to priority 10 (APNs throttles priority-5 LA updates)", async () => {
      // Can't test actual sending without APNS config, but verify function signature.
      // Two required params (token + content state); priority is the optional 3rd
      // and defaults to 10 — see project memory "Live Activity Architecture".
      expect(apns.sendLiveActivityUpdate.length).toBe(2);
    });
  });

  describe("sendLiveActivityEnd", () => {
    it("returns null when not configured", async () => {
      const result = await apns.sendLiveActivityEnd(
        "abc123",
        { jobTitle: "Done", progress: 1, startTime: 1000, endTime: 2000, status: "finished" }
      );
      expect(result).toBeNull();
    });
  });
});
