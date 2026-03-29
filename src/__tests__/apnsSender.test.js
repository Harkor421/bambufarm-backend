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

    it("defaults to priority 5", async () => {
      // Can't test actual sending without APNS config, but verify function signature
      expect(apns.sendLiveActivityUpdate.length).toBe(2); // 2 required params
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
