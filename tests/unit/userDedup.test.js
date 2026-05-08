const { dedupeUsersByBambuUid } = require("../../src/utils/userDedup");

describe("dedupeUsersByBambuUid", () => {
  test("collapses devices that share a bambu_uid", () => {
    const users = [
      // Newer device — winning rep, has email
      {
        _id: "a1",
        bambu_uid: "uid-1",
        bambu_email: "alice@example.com",
        createdAt: new Date("2026-04-01"),
        updatedAt: new Date("2026-05-01"),
      },
      // Older device on same uid, no email yet
      {
        _id: "a2",
        bambu_uid: "uid-1",
        bambu_email: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-02-01"),
      },
    ];
    const out = dedupeUsersByBambuUid(users);
    expect(out).toHaveLength(1);
    expect(out[0].rep._id).toBe("a1");
    expect(out[0].deviceCount).toBe(2);
    expect(out[0].email).toBe("alice@example.com");
    // firstSeen is the OLDER device's createdAt — when the human first signed up
    expect(out[0].firstSeen).toEqual(new Date("2025-01-01"));
  });

  test("falls back to older device's email when rep is missing it", () => {
    const users = [
      {
        _id: "rep",
        bambu_uid: "uid-2",
        bambu_email: null, // newer device but auth lost the email
        createdAt: new Date("2026-04-01"),
        updatedAt: new Date("2026-05-01"),
      },
      {
        _id: "old",
        bambu_uid: "uid-2",
        bambu_email: "bob@example.com",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-02-01"),
      },
    ];
    const out = dedupeUsersByBambuUid(users);
    expect(out[0].rep._id).toBe("rep");
    expect(out[0].email).toBe("bob@example.com");
  });

  test("users without bambu_uid each get their own group", () => {
    const users = [
      {
        _id: "x1",
        bambu_uid: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: "x2",
        bambu_uid: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const out = dedupeUsersByBambuUid(users);
    expect(out).toHaveLength(2);
  });

  test("orders groups by rep.updatedAt desc", () => {
    const users = [
      {
        _id: "old",
        bambu_uid: "uid-old",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-15"),
      },
      {
        _id: "new",
        bambu_uid: "uid-new",
        createdAt: new Date("2026-04-01"),
        updatedAt: new Date("2026-05-01"),
      },
      {
        _id: "mid",
        bambu_uid: "uid-mid",
        createdAt: new Date("2025-06-01"),
        updatedAt: new Date("2025-07-01"),
      },
    ];
    const out = dedupeUsersByBambuUid(users);
    expect(out.map((g) => g.rep._id)).toEqual(["new", "mid", "old"]);
  });

  test("collects every userId in the group", () => {
    const users = [
      { _id: "a", bambu_uid: "u", updatedAt: new Date("2026-05-01"), createdAt: new Date("2026-04-01") },
      { _id: "b", bambu_uid: "u", updatedAt: new Date("2026-04-01"), createdAt: new Date("2026-03-01") },
      { _id: "c", bambu_uid: "u", updatedAt: new Date("2026-03-01"), createdAt: new Date("2026-02-01") },
    ];
    const [g] = dedupeUsersByBambuUid(users);
    expect(g.userIds).toHaveLength(3);
    expect(g.userIds).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });

  test("empty input returns empty array", () => {
    expect(dedupeUsersByBambuUid([])).toEqual([]);
  });
});
