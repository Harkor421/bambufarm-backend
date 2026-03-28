const { Schema, model } = require("mongoose");

const printerStateSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
    printer_dev_id: { type: String, required: true },
    printer_name: { type: String, default: "Unknown" },
    last_status: { type: String, default: "unknown" },
    last_job_title: { type: String, default: null },
    last_progress_pct: { type: Number, default: null },

    // Notification-driven print state (source of truth for lifecycle)
    notif_status: { type: String, default: "idle" },       // "printing" | "paused" | "idle"
    notif_job_title: { type: String, default: null },
    notif_started_at: { type: Date, default: null },        // when print started (from notification)
    notif_cost_time_sec: { type: Number, default: null },   // estimated total print time
    notif_paused_at: { type: Date, default: null },         // when pause was detected
    notif_frozen_remaining_sec: { type: Number, default: null }, // remaining seconds at pause
    notif_frozen_progress_pct: { type: Number, default: null }, // progress at pause
    notif_task_id: { type: String, default: null },         // Bambu task ID
    notif_last_message_id: { type: String, default: null }, // last message that updated this state
    mqtt_last_notif_at: { type: Date, default: null },      // when MQTT last sent a notification (dedup)
  },
  { timestamps: true }
);

printerStateSchema.index({ user_id: 1, printer_dev_id: 1 }, { unique: true });

module.exports = model("PrinterState", printerStateSchema);
