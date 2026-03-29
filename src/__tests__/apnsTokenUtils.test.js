const { getActivityToken, isTokenInvalid } = require("../services/apnsTokenUtils");

describe("getActivityToken", () => {
  it("returns token from Map-like object", () => {
    const user = {
      la_activity_tokens: {
        get: (key) => (key === "printer1" ? "abc123" : null),
      },
    };
    expect(getActivityToken(user, "printer1")).toBe("abc123");
  });

  it("returns token from plain object", () => {
    const user = { la_activity_tokens: { printer1: "abc123" } };
    expect(getActivityToken(user, "printer1")).toBe("abc123");
  });

  it("returns null when no tokens exist", () => {
    expect(getActivityToken({}, "printer1")).toBeNull();
    expect(getActivityToken({ la_activity_tokens: null }, "printer1")).toBeNull();
  });

  it("returns null for non-existent printer", () => {
    const user = { la_activity_tokens: { printer1: "abc123" } };
    expect(getActivityToken(user, "printer2")).toBeNull();
  });
});

describe("isTokenInvalid", () => {
  it("returns true for 410 status", () => {
    expect(isTokenInvalid({ status: 410 })).toBe(true);
  });

  it("returns true for 400 BadDeviceToken", () => {
    expect(isTokenInvalid({ status: 400, reason: { reason: "BadDeviceToken" } })).toBe(true);
  });

  it("returns false for 200 success", () => {
    expect(isTokenInvalid({ status: 200, success: true })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isTokenInvalid(null)).toBe(false);
  });

  it("returns false for 400 non-BadDeviceToken", () => {
    expect(isTokenInvalid({ status: 400, reason: { reason: "PayloadTooLarge" } })).toBe(false);
  });
});
