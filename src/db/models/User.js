const { Schema, model } = require("mongoose");

const userSchema = new Schema(
  {
    expo_push_token: { type: String, required: true, unique: true },
    bambu_uid: { type: String, default: null, index: true },
    bambu_access_token: { type: String, required: true },
    bambu_refresh_token: { type: String, required: true },
    bambu_token_expires_at: { type: Number, required: true },
    fail_count: { type: Number, default: 0 },
    // ActivityKit push tokens for Live Activities
    la_push_to_start_token: { type: String, default: null },
    la_activity_tokens: { type: Map, of: String, default: {} },
  },
  { timestamps: true }
);

module.exports = model("User", userSchema);
