/**
 * laChannels: degrades to token-only while Apple says Broadcast is not
 * enabled, and only broadcasts when a live channel exists.
 */
jest.mock("../services/apnsSender", () => ({
  isConfigured: () => true,
  createChannel: jest.fn(),
  deleteChannel: jest.fn(async () => ({ success: true })),
  sendBroadcast: jest.fn(async () => ({ success: true, status: 200 })),
  liveActivityPayload: (event, cs) => ({ aps: { event, "content-state": cs } }),
}));
jest.mock("../db/models/LaChannel", () => ({
  findOneAndUpdate: jest.fn(() => ({ lean: async () => null })),
  findOne: jest.fn(() => ({ lean: async () => null })),
  updateOne: jest.fn(async () => ({})),
  deleteOne: jest.fn(async () => ({})),
  find: jest.fn(() => ({ limit: () => ({ lean: async () => [] }) })),
}));

const apns = require("../services/apnsSender");
const LaChannel = require("../db/models/LaChannel");
const laChannels = require("../services/laChannels");

beforeEach(() => {
  laChannels._reset();
  jest.clearAllMocks();
});

it("BroadcastFeatureNotEnabled → no channel, and no more create attempts for a while", async () => {
  apns.createChannel.mockResolvedValue({ success: false, status: 400, reason: "BroadcastFeatureNotEnabled" });
  expect(await laChannels.openForPrint("u", "D1", "k")).toBeNull();
  expect(await laChannels.openForPrint("u", "D2", "k")).toBeNull();
  expect(apns.createChannel).toHaveBeenCalledTimes(1);
  expect(laChannels.enabled()).toBe(false);
});

it("opens, persists and then broadcasts to the print's channel", async () => {
  apns.createChannel.mockResolvedValue({ success: true, status: 201, channelId: "CH" });
  expect(await laChannels.openForPrint("u", "D1", "k")).toBe("CH");
  expect(LaChannel.findOneAndUpdate).toHaveBeenCalled();
  const r = await laChannels.broadcast("u", "D1", "update", { status: "printing" }, { priority: 5 });
  expect(r.success).toBe(true);
  expect(apns.sendBroadcast).toHaveBeenCalledWith("CH", expect.objectContaining({ aps: expect.objectContaining({ event: "update" }) }), 5);
});

it("no channel for the printer → nothing is sent", async () => {
  expect(await laChannels.broadcast("u", "NOPE", "update", {})).toBeNull();
  expect(apns.sendBroadcast).not.toHaveBeenCalled();
});

it("ending marks the channel ended and stops later broadcasts", async () => {
  apns.createChannel.mockResolvedValue({ success: true, status: 201, channelId: "CH2" });
  await laChannels.openForPrint("u", "D3", "k");
  await laChannels.broadcast("u", "D3", "end", { status: "finished" });
  expect(LaChannel.updateOne).toHaveBeenCalledWith({ channel_id: "CH2" }, expect.objectContaining({ ended_at: expect.any(Date) }));
  expect(await laChannels.broadcast("u", "D3", "update", {})).toBeNull();
});
