const { Router } = require("express");
const { bootBackfillEmails, attachActivityLog } = require("./adminMetrics/_shared");

const router = Router();

// Side effect: subscribe to printer:stateChange events for the in-memory
// recent-activity ring buffer used by /overview and /activity. Runs once at
// require() time.
attachActivityLog();

// Mount each section's routes onto the shared router. Order doesn't matter —
// routes have unique paths.
require("./adminMetrics/overview")(router);
require("./adminMetrics/printers")(router);
require("./adminMetrics/users")(router);
require("./adminMetrics/bridges")(router);
require("./adminMetrics/cameras")(router);
require("./adminMetrics/activity")(router);
require("./adminMetrics/printerOps")(router);

module.exports = router;
module.exports.bootBackfillEmails = bootBackfillEmails;
