const { Schema, model } = require("mongoose");

const notificationHistorySchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
  bambu_message_id: { type: String, required: true },
  category: { type: String, required: true },
  title: { type: String },
  body: { type: String },
  sent_at: { type: Date, default: Date.now },
});

notificationHistorySchema.index({ user_id: 1, bambu_message_id: 1 }, { unique: true });
notificationHistorySchema.index({ sent_at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = model("NotificationHistory", notificationHistorySchema);
