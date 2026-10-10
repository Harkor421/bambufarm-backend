const mongoose = require("mongoose");

/**
 * Which farm Live Activity cards ("__farm__", "__farm__2"…) are live for an
 * account. Persisted so a server restart mid-print updates/ends the existing
 * cards instead of starting duplicates. See services/laFarm.
 */
const laFarmStateSchema = new mongoose.Schema({
  bambu_uid: { type: String, required: true, unique: true },
  groups: { type: [String], default: [] },
  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model("LaFarmState", laFarmStateSchema);
