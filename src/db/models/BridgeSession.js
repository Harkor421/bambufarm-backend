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

module.exports = model("BridgeSession", bridgeSessionSchema);
