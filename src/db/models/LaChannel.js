const mongoose = require("mongoose");

/**
 * One APNs broadcast channel per (Bambu account, printer) for the print in
 * progress. Live Activities created by push-to-start subscribe to it
 * (`input-push-channel`, iOS 18+), so the server can update and END them
 * without the per-activity token that iOS rarely hands us. Persisted so a
 * server restart mid-print can still close the card. See services/laChannels.
 */
const laChannelSchema = new mongoose.Schema({
  bambu_uid: { type: String, required: true },
  printer_dev_id: { type: String, required: true },
  channel_id: { type: String, required: true },
  print_key: { type: String, default: null },
  opened_at: { type: Date, default: Date.now },
  ended_at: { type: Date, default: null },
});

laChannelSchema.index({ bambu_uid: 1, printer_dev_id: 1 }, { unique: true });
laChannelSchema.index({ opened_at: 1 });

module.exports = mongoose.model("LaChannel", laChannelSchema);
