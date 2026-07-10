const mongoose = require("mongoose");
const log = require("../utils/logger");

const { mongoUri: MONGO_URI, mongoDbName: MONGO_DB_NAME } = require("../config");

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI, {
      maxPoolSize: 50,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      // When set (staging), overrides the database name in the URI so we hit an
      // isolated DB on the same cluster. Undefined in production → mongoose
      // keeps the connection string's own database.
      ...(MONGO_DB_NAME ? { dbName: MONGO_DB_NAME } : {}),
    });
    log.info(
      `[DB] Connected to MongoDB (pool: 5-50)${MONGO_DB_NAME ? ` [db=${MONGO_DB_NAME}]` : ""}`
    );
  } catch (err) {
    log.error(`[DB] MongoDB connection failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { connectDB, mongoose };
