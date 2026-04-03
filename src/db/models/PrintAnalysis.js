const { Schema, model } = require("mongoose");

const printAnalysisSchema = new Schema(
  {
    bambu_uid: { type: String, required: true, index: true },
    printer_dev_id: { type: String, required: true },
    analyzed_at: { type: Date, required: true, default: Date.now },
    layer_num: { type: Number, default: null },
    total_layers: { type: Number, default: null },
    mc_percent: { type: Number, default: null },
    gcode_state: { type: String, default: null },
    subtask_name: { type: String, default: null },
    verdict: { type: String, enum: ["ok", "warning", "failure"], required: true },
    confidence: { type: Number, default: 0 },
    issues: [{ type: String }],
    detail: { type: String, default: "" },
    notified: { type: Boolean, default: false },
    frame_size_bytes: { type: Number, default: 0 },
  },
  { timestamps: true }
);

printAnalysisSchema.index({ bambu_uid: 1, printer_dev_id: 1, analyzed_at: -1 });
printAnalysisSchema.index({ analyzed_at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 }); // 30-day TTL

module.exports = model("PrintAnalysis", printAnalysisSchema);
