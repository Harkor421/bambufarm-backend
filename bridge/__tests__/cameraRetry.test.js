const {
  getRetryDelay,
  recordFailure,
  clearFailures,
  clearAllFailures,
  isSuspended,
  getFailureCount,
} = require("../cameraRetry");

// The failure Map is module-level state — reset between tests.
afterEach(() => clearAllFailures());

describe("cameraRetry", () => {
  test("an unknown printer has clean defaults", () => {
    expect(getFailureCount("x")).toBe(0);
    expect(isSuspended("x")).toBe(false);
    expect(getRetryDelay("x")).toBe(5000);
  });

  test("retry delay backs off exponentially and caps at 5 min", () => {
    const seq = [];
    for (let i = 0; i < 8; i++) {
      recordFailure("p");
      seq.push(getRetryDelay("p"));
    }
    expect(seq).toEqual([5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]);
  });

  test("recordFailure increments the count", () => {
    recordFailure("p");
    recordFailure("p");
    expect(getFailureCount("p")).toBe(2);
  });

  test("the circuit breaker trips after 12 failures", () => {
    for (let i = 0; i < 11; i++) recordFailure("cb");
    expect(isSuspended("cb")).toBe(false);
    const f = recordFailure("cb"); // 12th
    expect(isSuspended("cb")).toBe(true);
    expect(f.suspendedReason).toBe("too-many-failures");
  });

  test("an auth failure suspends immediately", () => {
    const f = recordFailure("au", "authFailed");
    expect(f.suspended).toBe(true);
    expect(f.suspendedReason).toBe("auth");
    expect(isSuspended("au")).toBe(true);
  });

  test("clearFailures resets one printer and is a no-op for an unknown key", () => {
    recordFailure("p");
    clearFailures("p");
    expect(getFailureCount("p")).toBe(0);
    expect(() => clearFailures("never-seen")).not.toThrow();
  });

  test("clearAllFailures wipes every printer", () => {
    recordFailure("a");
    recordFailure("b");
    clearAllFailures();
    expect(getFailureCount("a")).toBe(0);
    expect(getFailureCount("b")).toBe(0);
  });
});
