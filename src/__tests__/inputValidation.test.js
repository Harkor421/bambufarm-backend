/**
 * Tests for input validation in register routes.
 * These validators protect the server from malformed/malicious input.
 */

const EXPO_TOKEN_RE = /^ExponentPushToken\[[a-zA-Z0-9_-]{20,50}\]$/;
const PRINTER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const HEX_TOKEN_RE = /^[a-f0-9]{20,200}$/i;

function isValidExpoToken(t) {
  return typeof t === "string" && EXPO_TOKEN_RE.test(t);
}
function isValidPrinterId(id) {
  return typeof id === "string" && PRINTER_ID_RE.test(id);
}
function isValidHexToken(t) {
  return typeof t === "string" && HEX_TOKEN_RE.test(t);
}

describe("isValidExpoToken", () => {
  it("accepts valid Expo push tokens", () => {
    expect(isValidExpoToken("ExponentPushToken[LfBbWGM8l1GhABCDEFGHIJ]")).toBe(true);
    expect(isValidExpoToken("ExponentPushToken[tpTOk4MK1dJjABCDEFGHIJ]")).toBe(true);
    expect(isValidExpoToken("ExponentPushToken[abcdefghij1234567890ab]")).toBe(true);
  });

  it("rejects invalid tokens", () => {
    expect(isValidExpoToken("")).toBe(false);
    expect(isValidExpoToken(null)).toBe(false);
    expect(isValidExpoToken(123)).toBe(false);
    expect(isValidExpoToken("not-a-token")).toBe(false);
    expect(isValidExpoToken("ExponentPushToken[]")).toBe(false);
    expect(isValidExpoToken("ExponentPushToken[short]")).toBe(false);
    // Injection attempts
    expect(isValidExpoToken("ExponentPushToken[abc'; DROP TABLE users;--]")).toBe(false);
    expect(isValidExpoToken("ExponentPushToken[<script>alert(1)</script>]")).toBe(false);
  });
});

describe("isValidPrinterId", () => {
  it("accepts valid printer IDs", () => {
    expect(isValidPrinterId("03919D571707148")).toBe(true);
    expect(isValidPrinterId("01P00C582701216")).toBe(true);
    expect(isValidPrinterId("printer-1")).toBe(true);
    expect(isValidPrinterId("my_printer_2")).toBe(true);
  });

  it("rejects invalid printer IDs", () => {
    expect(isValidPrinterId("")).toBe(false);
    expect(isValidPrinterId(null)).toBe(false);
    expect(isValidPrinterId("a".repeat(65))).toBe(false); // too long
    expect(isValidPrinterId("printer id with spaces")).toBe(false);
    expect(isValidPrinterId("printer/../../etc")).toBe(false);
    expect(isValidPrinterId("printer;rm -rf")).toBe(false);
  });
});

describe("isValidHexToken", () => {
  it("accepts valid hex tokens", () => {
    expect(isValidHexToken("408a77e1abcdef1234567890")).toBe(true);
    expect(isValidHexToken("40ae1132a03582d7abcdef1234567890")).toBe(true);
    expect(isValidHexToken("AABBCCDD11223344556677")).toBe(true); // case insensitive
  });

  it("rejects invalid tokens", () => {
    expect(isValidHexToken("")).toBe(false);
    expect(isValidHexToken("short")).toBe(false); // < 20 chars
    expect(isValidHexToken("zzzzzzzzzzzzzzzzzzzzzz")).toBe(false); // not hex
    expect(isValidHexToken(null)).toBe(false);
    expect(isValidHexToken("a".repeat(201))).toBe(false); // too long
  });
});
