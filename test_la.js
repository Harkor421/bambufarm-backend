const mongoose = require("mongoose");
const User = require("./src/db/models/User");
const apns = require("./src/services/apnsSender");
const log = require("./src/utils/logger");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  log.info("Connected to DB");

  // Find Samir's user (uid 1789751384 or by bambu token)
  const users = await User.find({ expo_push_token: { $exists: true, $ne: null } });
  let samir = null;
  for (const u of users) {
    if (u.bambu_tokens?.uid === "1789751384" || u.la_push_to_start_token) {
      log.info(`User ${u._id}: expo=${!!u.expo_push_token} pushToStart=${!!u.la_push_to_start_token} activityTokens=${u.la_activity_tokens?.size || 0}`);
      if (!samir && u.la_push_to_start_token) samir = u;
    }
  }

  if (!samir) {
    // Try finding by checking all users with push-to-start tokens
    samir = await User.findOne({ la_push_to_start_token: { $exists: true, $ne: null } });
  }

  if (!samir) {
    log.error("No user with push-to-start token found");
    process.exit(1);
  }

  log.info(`Using user ${samir._id}, pushToStartToken: ${samir.la_push_to_start_token?.slice(0,16)}...`);

  if (!apns.isConfigured()) {
    log.error("APNS not configured");
    process.exit(1);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const printerId = "TEST_PRINTER";
  const printerName = "Test Printer";

  // Step 1: Start a print via push-to-start
  log.info("=== STEP 1: Sending push-to-start (print started) ===");
  const startResult = await apns.sendLiveActivityStart(
    samir.la_push_to_start_token,
    { printerId, printerName },
    {
      jobTitle: "Test Print Job",
      progress: 0.0,
      startTime: nowSec,
      endTime: nowSec + 180, // 3 minutes
      status: "printing",
    }
  );
  log.info(`Start result: ${JSON.stringify(startResult)}`);

  if (!startResult?.success) {
    log.error("Push-to-start failed! Cannot continue test.");
    process.exit(1);
  }

  // Wait 10s for the activity token to be synced back
  log.info("Waiting 10s for activity token sync...");
  await new Promise(r => setTimeout(r, 10000));

  // Re-fetch user to get the activity token
  const refreshedUser = await User.findById(samir._id);
  const activityToken = refreshedUser.la_activity_tokens?.get?.(printerId) || refreshedUser.la_activity_tokens?.[printerId];
  log.info(`Activity token for ${printerId}: ${activityToken ? activityToken.slice(0,16) + '...' : 'NONE'}`);

  if (!activityToken) {
    log.warn("No activity token received yet - updates won't work. Waiting 5 more seconds...");
    await new Promise(r => setTimeout(r, 5000));
    const user2 = await User.findById(samir._id);
    const at2 = user2.la_activity_tokens?.get?.(printerId) || user2.la_activity_tokens?.[printerId];
    if (!at2) {
      log.error("Still no activity token. The app may not be sending tokens. Skipping update/pause test.");
      process.exit(0);
    }
  }

  // Step 2: Update progress to 30%
  log.info("=== STEP 2: Updating progress to 30% ===");
  const updResult = await apns.sendLiveActivityUpdate(activityToken, {
    jobTitle: "Test Print Job",
    progress: 0.3,
    startTime: nowSec,
    endTime: nowSec + 126, // 2:06 remaining
    status: "printing",
  });
  log.info(`Update result: ${JSON.stringify(updResult)}`);

  // Wait 5s
  await new Promise(r => setTimeout(r, 5000));

  // Step 3: Pause
  log.info("=== STEP 3: Pausing print ===");
  const pauseResult = await apns.sendLiveActivityUpdate(activityToken, {
    jobTitle: "Paused by user",
    progress: 0.3,
    startTime: nowSec,
    endTime: nowSec + 126,
    status: "paused",
  });
  log.info(`Pause result: ${JSON.stringify(pauseResult)}`);

  // Wait 5s
  await new Promise(r => setTimeout(r, 5000));

  // Step 4: Resume
  log.info("=== STEP 4: Resuming print ===");
  const resumeResult = await apns.sendLiveActivityUpdate(activityToken, {
    jobTitle: "Test Print Job",
    progress: 0.5,
    startTime: nowSec,
    endTime: nowSec + 90, // 1:30 remaining
    status: "printing",
  });
  log.info(`Resume result: ${JSON.stringify(resumeResult)}`);

  // Wait 5s
  await new Promise(r => setTimeout(r, 5000));

  // Step 5: End (finished)
  log.info("=== STEP 5: Ending print (finished) ===");
  const endResult = await apns.sendLiveActivityEnd(activityToken, {
    jobTitle: "Test Print Job",
    progress: 1.0,
    startTime: nowSec,
    endTime: nowSec,
    status: "finished",
  });
  log.info(`End result: ${JSON.stringify(endResult)}`);

  log.info("=== TEST COMPLETE ===");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
