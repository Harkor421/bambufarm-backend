const mongoose = require("mongoose");
const log = require("../utils/logger");

const { mongoUri: MONGO_URI } = require("../config");

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI, {
      maxPoolSize: 50,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    log.info("[DB] Connected to MongoDB (pool: 5-50)");
  } catch (err) {
    log.error(`[DB] MongoDB connection failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { connectDB, mongoose };
