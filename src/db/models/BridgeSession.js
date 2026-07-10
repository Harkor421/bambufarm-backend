const { Schema, model } = require("mongoose");

const bridgeSessionSchema = new Schema(
  {
    bambu_uid: { type: String, required: true, index: true },
    connected_at: { type: Date, required: true },
    disconnected_at: { type: Date, default: null },
    printer_count: { type: Number, default: 0 },
    last_active_at: { type: Date, default: null },
  },
  { timestamps: true }
);

// Bound the collection: it grows one row per bridge connect, unbounded
// otherwise. 90-day TTL also backs adminMetrics/overview.js range scans.
// Semantic note: "bridges ever used" becomes "used within 90d", and a
// >90d-old still-open session row expires (the metrics routes degrade
// gracefully).
bridgeSessionSchema.index({ connected_at: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

module.exports = model("BridgeSession", bridgeSessionSchema);
