const User = require("../../db/models/User");
const PrinterState = require("../../db/models/PrinterState");
const requireAdmin = require("../../middleware/adminAuth");
const log = require("../../utils/logger");

/**
 * GET  /api/admin/metrics/cameras
 *   Lists every camera with a live frame in the in-memory cache (every printer
 *   of every user currently running BambuBridge with the camera streaming).
 *   Cross-references PrinterState for printer name + status.
 *
 * GET  /api/admin/metrics/cameras/:bambuUid/:printerId/frame
 *   Returns the latest JPEG frame as image/jpeg bytes. Designed to be used
 *   directly as <img src=...> with cache-busting query params.
 */
module.exports = (router) => {
  router.get("/admin/metrics/cameras", requireAdmin, async (_req, res) => {
    try {
      const wsManager = require("../../services/wsManager");

      // Tell bridges to stream EVERY camera while the admin is viewing this tab.
      // The frontend polls every ~8s; this re-arms a 30s window so as long as
      // the admin keeps viewing, bridges keep streaming. Naturally lapses ~30s
      // after they navigate away.
      wsManager.markAdminCameraDemand().catch(() => {});

      // Build the cameras list in two passes:
      // (1) every printer of every CONNECTED bridge, regardless of frame
      //     availability — lets the admin see "bridge online but camera not
      //     streaming" cases (LAN-only mode off, wrong access code, printer
      //     unreachable, etc.) instead of silently omitting those users.
      // (2) any cached frames also surface (bridges may have streamed without
      //     us having a current bridges entry, edge case during reconnect).

      const items = [];
      const seen = new Set(); // `${uid}:${printerId}`

      // Step 1: gather (uid, printerId) pairs from every connected bridge's known printers.
      const bridgeUids = wsManager.bridges ? [...wsManager.bridges.keys()] : [];
      const bridgePrinters = [];

      if (bridgeUids.length > 0) {
        const bridgeUsers = await User.find({ bambu_uid: { $in: bridgeUids } })
          .select("_id bambu_uid expo_push_token")
          .lean();
        const userIdsByUid = {};
        const allUserIds = [];
        const userByUid = {};
        for (const u of bridgeUsers) {
          if (!userIdsByUid[u.bambu_uid]) userIdsByUid[u.bambu_uid] = [];
          userIdsByUid[u.bambu_uid].push(u._id);
          if (!userByUid[u.bambu_uid]) userByUid[u.bambu_uid] = u;
          allUserIds.push(u._id);
        }

        const states = await PrinterState.find({ user_id: { $in: allUserIds } })
          .select("user_id printer_dev_id printer_name notif_status notif_job_title")
          .lean();

        for (const s of states) {
          // Map user_id back to bambu_uid
          let foundUid = null;
          for (const [uid, ids] of Object.entries(userIdsByUid)) {
            if (ids.some((id) => String(id) === String(s.user_id))) {
              foundUid = uid;
              break;
            }
          }
          if (!foundUid) continue;
          const key = `${foundUid}:${s.printer_dev_id}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const hasFrame = !!wsManager.getLatestFrame(foundUid, s.printer_dev_id);
          const u = userByUid[foundUid];
          bridgePrinters.push({
            bambuUid: foundUid,
            printerId: s.printer_dev_id,
            printerName: s.printer_name || s.printer_dev_id,
            status: s.notif_status || "unknown",
            jobTitle: s.notif_job_title || null,
            hasFrame,
            ownerPushTokenTail: u?.expo_push_token ? u.expo_push_token.slice(-12) : null,
          });
        }
      }
      items.push(...bridgePrinters);

      // Step 2: any cached frames not already covered above (e.g. user
      // disconnected bridge mid-poll but we still have a recent frame).
      if (wsManager.latestFrames) {
        const orphanIds = new Set();
        for (const [bambuUid, userFrames] of wsManager.latestFrames) {
          for (const printerId of userFrames.keys()) {
            const key = `${bambuUid}:${printerId}`;
            if (!seen.has(key)) {
              seen.add(key);
              orphanIds.add(printerId);
              items.push({
                bambuUid,
                printerId,
                printerName: printerId,
                status: "unknown",
                jobTitle: null,
                hasFrame: true,
                ownerPushTokenTail: null,
              });
            }
          }
        }
        // Backfill names for orphan entries if we can find them
        if (orphanIds.size > 0) {
          const orphanStates = await PrinterState.find({
            printer_dev_id: { $in: [...orphanIds] },
          })
            .select("printer_dev_id printer_name notif_status notif_job_title")
            .lean();
          const orphanMap = {};
          for (const s of orphanStates) {
            if (!orphanMap[s.printer_dev_id]) orphanMap[s.printer_dev_id] = s;
          }
          for (const item of items) {
            if (item.printerName === item.printerId && orphanMap[item.printerId]) {
              const s = orphanMap[item.printerId];
              item.printerName = s.printer_name || item.printerName;
              item.status = s.notif_status || item.status;
              item.jobTitle = s.notif_job_title || item.jobTitle;
            }
          }
        }
      }

      // Sort: streaming first (by status: printing, paused, idle), then offline.
      items.sort((a, b) => {
        if (a.hasFrame !== b.hasFrame) return a.hasFrame ? -1 : 1;
        const order = { printing: 0, paused: 1, idle: 2, unknown: 3 };
        const cmp = (order[a.status] ?? 99) - (order[b.status] ?? 99);
        if (cmp !== 0) return cmp;
        return a.printerName.localeCompare(b.printerName);
      });

      const streamingCount = items.filter((i) => i.hasFrame).length;
      res.json({
        ok: true,
        total: items.length,
        streaming: streamingCount,
        offline: items.length - streamingCount,
        items,
      });
    } catch (err) {
      log.error(`[ADMIN] Cameras list error: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get(
    "/admin/metrics/cameras/:bambuUid/:printerId/frame",
    requireAdmin,
    (req, res) => {
      try {
        const { bambuUid, printerId } = req.params;
        const wsManager = require("../../services/wsManager");
        const frame = wsManager.getLatestFrame(bambuUid, printerId);
        if (!frame) return res.status(404).end();

        res.set({
          "Content-Type": "image/jpeg",
          "Content-Length": frame.length,
          // Don't cache — the next request should get a fresh frame
          "Cache-Control": "no-store, max-age=0",
        });
        res.end(frame);
      } catch (err) {
        log.error(`[ADMIN] Camera frame error: ${err.message}`);
        res.status(500).end();
      }
    }
  );
};
