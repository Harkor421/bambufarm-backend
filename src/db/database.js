const mongoose = require("mongoose");
const log = require("../utils/logger");

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/bambufarm";

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
