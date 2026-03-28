const { Schema, model } = require("mongoose");

const messageStateSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    last_seen_message_id: { type: String, default: null },
    last_poll_at: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = model("MessageState", messageStateSchema);
