const { Router } = require("express");
const config = require("../config");

const router = Router();

/**
 * Remote knobs the app reads at launch. Kept tiny and cacheable: it is hit
 * once per app foreground by every client, so no DB work here.
 */
router.get("/app-config", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    ok: true,
    legacyGraceUntil: config.subscription.legacyGraceUntil,
  });
});

module.exports = router;
