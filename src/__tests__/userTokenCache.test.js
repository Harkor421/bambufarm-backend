// Mock the User model so the cache is tested without a DB.
jest.mock("../db/models/User", () => ({ findOne: jest.fn() }));
const User = require("../db/models/User");
const { getUserByPushToken, invalidateUserToken } = require("../services/userTokenCache");

// User.findOne({...}).lean() — return a thenable-less object with .lean()
function mockDbUser(u) {
  User.findOne.mockReturnValue({ lean: () => Promise.resolve(u) });
}

beforeEach(() => User.findOne.mockReset());

describe("userTokenCache", () => {
  test("a found user is cached — the second read skips Mongo", async () => {
    mockDbUser({ _id: "1", bambu_uid: "uidA" });
    const a = await getUserByPushToken("tokA");
    const b = await getUserByPushToken("tokA");
    expect(a.bambu_uid).toBe("uidA");
    expect(b.bambu_uid).toBe("uidA");
    expect(User.findOne).toHaveBeenCalledTimes(1); // 2nd served from cache
  });

  test("invalidate forces a re-fetch (a changed bambu_uid is picked up)", async () => {
    mockDbUser({ _id: "1", bambu_uid: "uidA" });
    await getUserByPushToken("tokB");
    invalidateUserToken("tokB");
    mockDbUser({ _id: "1", bambu_uid: "uidB" }); // e.g. re-login to a new account
    const after = await getUserByPushToken("tokB");
    expect(after.bambu_uid).toBe("uidB");
    expect(User.findOne).toHaveBeenCalledTimes(2);
  });

  test("a null result is NOT cached — unknown tokens re-hit Mongo", async () => {
    mockDbUser(null);
    await getUserByPushToken("tokC");
    await getUserByPushToken("tokC");
    expect(User.findOne).toHaveBeenCalledTimes(2);
  });

  test("an entry expires after the 60s TTL and is re-fetched", async () => {
    const now = 1_000_000;
    const spy = jest.spyOn(Date, "now").mockReturnValue(now);
    mockDbUser({ _id: "1", bambu_uid: "uidA" });
    await getUserByPushToken("tokD");
    spy.mockReturnValue(now + 61_000); // >60s later
    await getUserByPushToken("tokD");
    expect(User.findOne).toHaveBeenCalledTimes(2); // expired -> re-fetch
    spy.mockRestore();
  });

  test("a read within the TTL does NOT extend freshness (TTL is from fetch)", async () => {
    const now = 2_000_000;
    const spy = jest.spyOn(Date, "now").mockReturnValue(now);
    mockDbUser({ _id: "1", bambu_uid: "uidA" });
    await getUserByPushToken("tokE"); // fetched at now
    spy.mockReturnValue(now + 40_000); // 40s: still fresh, read (would extend a naive impl)
    await getUserByPushToken("tokE");
    spy.mockReturnValue(now + 65_000); // 65s from ORIGINAL fetch -> expired
    await getUserByPushToken("tokE");
    expect(User.findOne).toHaveBeenCalledTimes(2); // 1 initial + 1 after expiry (mid read was cached)
    spy.mockRestore();
  });
});
