const { isTecnoprintsAccount } = require("../services/tecnoprintsBroadcast");

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
});
