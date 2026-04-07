const mongoose = require("mongoose");
const log = require("../utils/logger");

const { mongoUri: MONGO_URI } = require("../config");

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI);
    log.info("[DB] Connected to MongoDB");
  } catch (err) {
    log.error(`[DB] MongoDB connection failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { connectDB, mongoose };
