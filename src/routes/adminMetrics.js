const { Router } = require("express");
const User = require("../db/models/User");
const PrinterState = require("../db/models/PrinterState");
const BridgeSession = require("../db/models/BridgeSession");
const requireAdmin = require("../middleware/adminAuth");
const log = require("../utils/logger");

const router = Router();

/**
 * Recent state-change activity log (in-memory, last N events).
 * Populated by mqttPrinterService via eventBus (see _attachActivityLog below).
 */
const RECENT_ACTIVITY_MAX = 200;
const recentActivity = [];

function attachActivityLog() {
  try {
    const eventBus = require("../services/eventBus");
    eventBus.on("printer:stateChange", ({ bambuUid, devId, state, prev }) => {
      recentActivity.unshift({
        at: new Date().toISOString(),
        bambuUid: String(bambuUid || ""),
        printerId: devId,
        from: prev || "?",
        to: state?.gcode_state || "?",
        progress: state?.mc_percent ?? null,
        jobTitle: state?.subtask_name || null,
      });
      if (recentActivity.length > RECENT_ACTIVITY_MAX) recentActivity.length = RECENT_ACTIVITY_MAX;
    });
  } catch (err) {
    log.warn(`[ADMIN] Could not attach activity log listener: ${err.message}`);
  }
}
attachActivityLog();

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/metrics/overview
 *
 * High-level dashboard numbers: users, bridges, currently active prints, etc.
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/admin/metrics/overview", requireAdmin, async (_req, res) => {
  try {
    const wsManager = require("../services/wsManager");
    const mqttService = require("../services/mqttPrinterService");

    // Window helpers
    const now = Date.now();
    const mins = (m) => new Date(now - m * 60_000);
    const hrs = (h) => new Date(now - h * 60 * 60_000);
    const days = (d) => new Date(now - d * 24 * 60 * 60_000);

    // ── User counts ─────────────────────────────────────────────
    const totalUsers = await User.countDocuments();
    const uniqueAccounts = await User.distinct("bambu_uid", { bambu_uid: { $ne: null } });
    const failedUsers = await User.countDocuments({ fail_count: { $gte: 5 } });
    const usersLastDay = await User.countDocuments({ updatedAt: { $gte: days(1) } });
    const usersLast7d = await User.countDocuments({ updatedAt: { $gte: days(7) } });

    // ── Bridge stats (live + historical) ────────────────────────
    let bridgesConnected = 0;
    const connectedBridgeUids = new Set();
    if (wsManager.bridges) {
      for (const [uid, set] of wsManager.bridges) {
        bridgesConnected += set.size || 0;
        if ((set.size || 0) > 0) connectedBridgeUids.add(uid);
      }
    }
    const bridgesLastHour = (await BridgeSession.distinct("bambu_uid", { connected_at: { $gte: hrs(1) } })).length;
    const bridgesLast24h = (await BridgeSession.distinct("bambu_uid", { connected_at: { $gte: hrs(24) } })).length;
    const bridgesEverUsed = (await BridgeSession.distinct("bambu_uid")).length;

    // ── App WebSocket clients ───────────────────────────────────
    let appClientsConnected = 0;
    let uniqueAppUids = 0;
    if (wsManager.appClients) {
      for (const [, set] of wsManager.appClients) appClientsConnected += set.size || 0;
      uniqueAppUids = wsManager.appClients.size;
    }

    // ── MQTT printer connections ────────────────────────────────
    let mqttConnections = 0;
    let mqttConnected = 0;
    if (mqttService.connections) {
      mqttConnections = mqttService.connections.size;
      for (const conn of mqttService.connections.values()) {
        if (conn.connected) mqttConnected++;
      }
    }

    // ── Print states ────────────────────────────────────────────
    const totalPrinters = await PrinterState.countDocuments();
    const printing = await PrinterState.countDocuments({ notif_status: "printing" });
    const paused = await PrinterState.countDocuments({ notif_status: "paused" });
    const idle = await PrinterState.countDocuments({ notif_status: "idle" });

    // Recent state transitions
    const transitionsLastHour = recentActivity.filter((a) => Date.parse(a.at) >= hrs(1).getTime()).length;
    const transitionsLast24h = recentActivity.filter((a) => Date.parse(a.at) >= hrs(24).getTime()).length;

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      users: {
        totalRegistered: totalUsers,
        uniqueBambuAccounts: uniqueAccounts.length,
        failed: failedUsers,
        activeLastDay: usersLastDay,
        activeLast7d: usersLast7d,
      },
      bridges: {
        currentlyConnected: bridgesConnected,
        uniqueUsersConnected: connectedBridgeUids.size,
        activeLastHour: bridgesLastHour,
        activeLast24h: bridgesLast24h,
        everUsed: bridgesEverUsed,
      },
      app: {
        wsConnections: appClientsConnected,
        uniqueUsers: uniqueAppUids,
      },
      mqtt: {
        totalConnections: mqttConnections,
        connected: mqttConnected,
      },
      printers: {
        total: totalPrinters,
        printing,
        paused,
        idle,
      },
      activity: {
        transitionsLastHour,
        transitionsLast24h,
        bufferSize: recentActivity.length,
      },
    });
  } catch (err) {
    log.error(`[ADMIN] Overview error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/metrics/printers?status=printing&limit=200
 *
 * List every printer with its current state, owner, progress, ETA.
 * Supports filtering by status and pagination via limit/offset.
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/admin/metrics/printers", requireAdmin, async (req, res) => {
  try {
    const status = req.query.status; // "printing" | "paused" | "idle" | undefined
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;

    const query = {};
    if (status) query.notif_status = status;

    const total = await PrinterState.countDocuments(query);

    // Sort: printing first, then paused, then by most recent update
    const printers = await PrinterState.find(query)
      .sort({ notif_status: 1, updatedAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean();

    // Hydrate with bambu_uid + expo_push_token tail (for cross-referencing)
    const userIds = [...new Set(printers.map((p) => String(p.user_id)))];
    const users = await User.find({ _id: { $in: userIds } })
      .select("_id bambu_uid expo_push_token createdAt")
      .lean();
    const userMap = Object.fromEntries(users.map((u) => [String(u._id), u]));

    // Pull live MQTT state for currently-connected printers (overlays DB state)
    const mqttService = require("../services/mqttPrinterService");
    const liveStates = new Map();
    if (mqttService.connections) {
      for (const conn of mqttService.connections.values()) {
        if (!conn.printerStates) continue;
        for (const [devId, state] of conn.printerStates) {
          liveStates.set(devId, {
            gcode_state: state.gcode_state,
            mc_percent: state.mc_percent,
            mc_remaining_time: state.mc_remaining_time,
            subtask_name: state.subtask_name,
            layer_num: state.layer_num,
            total_layer_num: state.total_layer_num,
            nozzle_temper: state.nozzle_temper,
            bed_temper: state.bed_temper,
            hms: Array.isArray(state.hms) ? state.hms.length : 0,
          });
        }
      }
    }

    const items = printers.map((p) => {
      const user = userMap[String(p.user_id)] || null;
      const live = liveStates.get(p.printer_dev_id) || null;
      return {
        printerId: p.printer_dev_id,
        printerName: p.printer_name,
        status: p.notif_status,
        jobTitle: p.notif_job_title || p.last_job_title || null,
        startedAt: p.notif_started_at,
        costTimeSec: p.notif_cost_time_sec,
        pausedAt: p.notif_paused_at,
        progressAtPause: p.notif_frozen_progress_pct,
        remainingAtPause: p.notif_frozen_remaining_sec,
        updatedAt: p.updatedAt,
        owner: user ? {
          userId: String(user._id),
          bambuUid: user.bambu_uid,
          pushTokenTail: user.expo_push_token ? user.expo_push_token.slice(-12) : null,
          registeredAt: user.createdAt,
        } : null,
        live, // live MQTT snapshot (null if MQTT not connected for this printer)
      };
    });

    res.json({ ok: true, total, limit, offset, items });
  } catch (err) {
    log.error(`[ADMIN] Printers error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/metrics/users?limit=100&hasBridge=1
 *
 * List users with summary info. Optional filter: hasBridge=1 → only users
 * who have ever connected a BambuBridge.
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/admin/metrics/users", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const hasBridge = req.query.hasBridge === "1";

    let bridgeUids = null;
    if (hasBridge) {
      bridgeUids = new Set(await BridgeSession.distinct("bambu_uid"));
    }

    const query = {};
    if (hasBridge) query.bambu_uid = { $in: [...bridgeUids] };

    const total = await User.countDocuments(query);
    const users = await User.find(query)
      .sort({ updatedAt: -1 })
      .skip(offset)
      .limit(limit)
      .select("_id bambu_uid expo_push_token bambu_token_expires_at fail_count la_push_to_start_token createdAt updatedAt")
      .lean();

    // Bridge counts per user (for the visible page)
    const bambuUids = users.map((u) => u.bambu_uid).filter(Boolean);
    const bridgeAgg = await BridgeSession.aggregate([
      { $match: { bambu_uid: { $in: bambuUids } } },
      { $group: {
        _id: "$bambu_uid",
        sessionCount: { $sum: 1 },
        lastConnected: { $max: "$connected_at" },
        anyOpen: { $sum: { $cond: [{ $eq: ["$disconnected_at", null] }, 1, 0] } },
      }},
    ]);
    const bridgeMap = Object.fromEntries(bridgeAgg.map((b) => [b._id, b]));

    // Printer counts per user (for the visible page)
    const userIds = users.map((u) => u._id);
    const printerAgg = await PrinterState.aggregate([
      { $match: { user_id: { $in: userIds } } },
      { $group: {
        _id: "$user_id",
        printerCount: { $sum: 1 },
        printingCount: { $sum: { $cond: [{ $eq: ["$notif_status", "printing"] }, 1, 0] } },
        pausedCount: { $sum: { $cond: [{ $eq: ["$notif_status", "paused"] }, 1, 0] } },
      }},
    ]);
    const printerMap = Object.fromEntries(printerAgg.map((p) => [String(p._id), p]));

    // Live: which bambuUids currently have a bridge WS open?
    const wsManager = require("../services/wsManager");
    const liveBridgeUids = new Set();
    if (wsManager.bridges) {
      for (const [uid, set] of wsManager.bridges) {
        if ((set.size || 0) > 0) liveBridgeUids.add(uid);
      }
    }

    const items = users.map((u) => {
      const bridge = bridgeMap[u.bambu_uid] || null;
      const printer = printerMap[String(u._id)] || null;
      return {
        userId: String(u._id),
        bambuUid: u.bambu_uid,
        pushTokenTail: u.expo_push_token ? u.expo_push_token.slice(-12) : null,
        tokenExpiresAt: u.bambu_token_expires_at,
        failCount: u.fail_count,
        hasLiveActivities: !!u.la_push_to_start_token,
        registeredAt: u.createdAt,
        lastSeenAt: u.updatedAt,
        bridge: bridge ? {
          sessionCount: bridge.sessionCount,
          lastConnected: bridge.lastConnected,
          currentlyConnected: liveBridgeUids.has(u.bambu_uid),
        } : { sessionCount: 0, lastConnected: null, currentlyConnected: false },
        printers: printer ? {
          total: printer.printerCount,
          printing: printer.printingCount,
          paused: printer.pausedCount,
        } : { total: 0, printing: 0, paused: 0 },
      };
    });

    res.json({ ok: true, total, limit, offset, items });
  } catch (err) {
    log.error(`[ADMIN] Users error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/metrics/bridges
 *
 * Currently-connected bridges with uid, connected-since, printer count.
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/admin/metrics/bridges", requireAdmin, async (_req, res) => {
  try {
    const wsManager = require("../services/wsManager");
    const items = [];

    if (wsManager.bridges) {
      const uids = [...wsManager.bridges.keys()];
      // Find the matching open BridgeSession for each connected uid
      const openSessions = await BridgeSession.find({
        bambu_uid: { $in: uids },
        disconnected_at: null,
      })
        .sort({ connected_at: -1 })
        .lean();
      const sessionMap = {};
      for (const s of openSessions) {
        if (!sessionMap[s.bambu_uid]) sessionMap[s.bambu_uid] = s;
      }

      // Look up the user record(s) for each uid
      const users = await User.find({ bambu_uid: { $in: uids } })
        .select("_id bambu_uid expo_push_token createdAt")
        .lean();
      const userMap = {};
      for (const u of users) {
        if (!userMap[u.bambu_uid]) userMap[u.bambu_uid] = u;
      }

      for (const [uid, set] of wsManager.bridges) {
        const session = sessionMap[uid];
        const user = userMap[uid];
        items.push({
          bambuUid: uid,
          connectionCount: set.size || 0,
          connectedAt: session ? session.connected_at : null,
          owner: user ? {
            userId: String(user._id),
            pushTokenTail: user.expo_push_token ? user.expo_push_token.slice(-12) : null,
            registeredAt: user.createdAt,
          } : null,
        });
      }
    }

    items.sort((a, b) => (b.connectedAt ? Date.parse(b.connectedAt) : 0) - (a.connectedAt ? Date.parse(a.connectedAt) : 0));

    res.json({ ok: true, total: items.length, items });
  } catch (err) {
    log.error(`[ADMIN] Bridges error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/metrics/cameras
 *
 * Lists every camera with a live frame in the in-memory cache (i.e. every
 * printer of every user currently running BambuBridge with the camera streaming).
 * Cross-references PrinterState for printer name + status.
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/admin/metrics/cameras", requireAdmin, async (_req, res) => {
  try {
    const wsManager = require("../services/wsManager");

    // Tell bridges to stream EVERY camera while the admin is viewing this tab.
    // The frontend polls every ~8s; this re-arms a 30s window so as long as
    // the admin keeps viewing, bridges keep streaming. Naturally lapses ~30s
    // after they navigate away.
    wsManager.markAdminCameraDemand().catch(() => {});

    // Build the cameras list in two passes:
    // (1) every printer of every CONNECTED bridge, regardless of frame availability —
    //     this lets the admin see "bridge online but camera not streaming" cases
    //     (LAN-only mode off, wrong access code, printer unreachable, etc.) instead
    //     of silently omitting those users.
    // (2) any cached frames also surface (bridges may have streamed without us
    //     having a current bridges entry, edge case during reconnect).

    const items = [];
    const seen = new Set(); // `${uid}:${printerId}`

    // Step 1: gather (uid, printerId) pairs from every connected bridge's known printers.
    const bridgeUids = wsManager.bridges ? [...wsManager.bridges.keys()] : [];
    let bridgePrinters = []; // [{ bambuUid, printerId, printerName, status, jobTitle, hasFrame }]

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
          if (ids.some((id) => String(id) === String(s.user_id))) { foundUid = uid; break; }
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

    // Step 2: any cached frames not already covered above (e.g. user disconnected
    // bridge mid-poll but we still have a recent frame in memory).
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
        const orphanStates = await PrinterState.find({ printer_dev_id: { $in: [...orphanIds] } })
          .select("printer_dev_id printer_name notif_status notif_job_title")
          .lean();
        const orphanMap = {};
        for (const s of orphanStates) if (!orphanMap[s.printer_dev_id]) orphanMap[s.printer_dev_id] = s;
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

    // Sort: streaming first (by status: printing, paused, idle), then offline cameras
    items.sort((a, b) => {
      // Frames-available cameras first
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

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/metrics/cameras/:bambuUid/:printerId/frame
 *
 * Returns the latest JPEG frame as image/jpeg bytes. Designed to be used
 * directly as <img src=...> with cache-busting query params.
 *
 * Password may be provided via either:
 *   - X-Admin-Password header (preferred)
 *   - ?password=... query param (necessary for <img> tags which can't set headers)
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/admin/metrics/cameras/:bambuUid/:printerId/frame", requireAdmin, (req, res) => {
  try {
    const { bambuUid, printerId } = req.params;
    const wsManager = require("../services/wsManager");
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
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/metrics/activity?limit=100
 *
 * Recent state transitions (live feed). In-memory ring buffer, last 200.
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/admin/metrics/activity", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, RECENT_ACTIVITY_MAX);
    res.json({ ok: true, total: recentActivity.length, items: recentActivity.slice(0, limit) });
  } catch (err) {
    log.error(`[ADMIN] Activity error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * POST /api/admin/metrics/printer/ams-filament
 *
 * Test/manual endpoint to update an AMS slot's color + material via MQTT.
 * Body: { bambuUid, printerId, amsId, trayId, trayColor, trayType,
 *         trayInfoIdx?, nozzleTempMin?, nozzleTempMax? }
 *
 * Bambu only honors this when the printer is IDLE or PAUSE — it's silently
 * ignored during an active print. Use sparingly while testing.
 * ───────────────────────────────────────────────────────────────────────── */
router.post("/admin/metrics/printer/ams-filament", requireAdmin, async (req, res) => {
  try {
    const { bambuUid, printerId, amsId = 0, trayId, trayColor, trayType, trayInfoIdx, nozzleTempMin, nozzleTempMax } = req.body || {};
    if (!bambuUid || !printerId || trayId == null || !trayColor || !trayType) {
      return res.status(400).json({
        ok: false,
        error: "Required: bambuUid, printerId, trayId, trayColor (RRGGBBAA hex), trayType",
      });
    }
    const mqttService = require("../services/mqttPrinterService");
    const sent = mqttService.setAmsFilament(String(bambuUid), printerId, {
      amsId: Number(amsId),
      trayId: Number(trayId),
      trayColor,
      trayType,
      trayInfoIdx,
      nozzleTempMin: nozzleTempMin != null ? Number(nozzleTempMin) : undefined,
      nozzleTempMax: nozzleTempMax != null ? Number(nozzleTempMax) : undefined,
    });
    if (!sent) {
      return res.status(503).json({
        ok: false,
        error: "MQTT not connected for this user — printer may be offline or user not registered",
      });
    }
    log.info(`[ADMIN] ams_filament_setting sent: uid=${bambuUid} printer=${printerId} ams=${amsId} tray=${trayId} color=${trayColor} type=${trayType}`);
    res.json({ ok: true, message: "Command sent — check the printer in 1-2 seconds" });
  } catch (err) {
    log.error(`[ADMIN] ams-filament error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * POST /api/admin/metrics/printer/probe
 *
 * Probe which Bambu cloud MQTT commands work without bridge signing.
 * Sends each command in `commands` (or a default safe-ish suite) in series,
 * waiting up to `timeoutMs` per command for a reply matched by sequence_id.
 *
 * A `response: null` after timeout = Bambu silently dropped the command,
 * which usually means signing is required (only the bridge can do it).
 * A `response.result === "success"` = command worked direct on cloud.
 * A `response.reason` or `response.result === "fail"` = Bambu rejected it
 * with a known error (signing/auth/state-machine etc.).
 *
 * Body:
 *   bambuUid: string                       (required)
 *   printerId: string                      (required)
 *   commands?: string[]                    (optional, defaults to safe suite)
 *   timeoutMs?: number                     (optional, default 4000)
 *
 * IMPORTANT: only run on an IDLE printer. Some commands in the suite
 * (pause/resume/stop) would interrupt an active print if Bambu actually
 * accepts them.
 * ───────────────────────────────────────────────────────────────────────── */

// Probe suite. Each entry: { name, subKey, payload }
// `payload[subKey].sequence_id` is filled in by probeCommand.
const PROBE_SUITE = {
  // Already known to work on cloud (used in production)
  light_on: {
    subKey: "system",
    payload: { system: { command: "ledctrl", led_node: "chamber_light", led_mode: "on", led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } },
  },
  light_off: {
    subKey: "system",
    payload: { system: { command: "ledctrl", led_node: "chamber_light", led_mode: "off", led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } },
  },
  speed_standard: {
    subKey: "print",
    payload: { print: { command: "print_speed", param: "2" } },
  },
  // The one we just wired up
  ams_filament: {
    subKey: "print",
    payload: {
      print: {
        command: "ams_filament_setting",
        ams_id: 0, tray_id: 0,
        tray_color: "26FF9AFF", tray_type: "PLA",
        tray_info_idx: "GFL00", nozzle_temp_min: 190, nozzle_temp_max: 230,
      },
    },
  },
  // pushall is informational, not a control command — should always work
  pushall: {
    subKey: "pushing",
    payload: { pushing: { command: "pushall", version: 1, push_target: 1 } },
  },
  // Suspected to require signing
  pause: {
    subKey: "print",
    payload: { print: { command: "pause" } },
  },
  resume: {
    subKey: "print",
    payload: { print: { command: "resume" } },
  },
  stop: {
    subKey: "print",
    payload: { print: { command: "stop" } },
  },
  // Single g-code line — print_speed equivalent via raw gcode
  gcode_M105: {
    subKey: "print",
    payload: { print: { command: "gcode_line", param: "M105\n" } },
  },
  // Filament unload from extruder (idle only)
  unload_filament: {
    subKey: "print",
    payload: { print: { command: "unload_filament" } },
  },
  // Calibration (full self-test) — destructive-ish, only included if explicitly asked
  calibration: {
    subKey: "print",
    payload: { print: { command: "calibration", option: 0 } },
  },
  // Clear print error (recover from paused-with-error)
  clean_print_error: {
    subKey: "print",
    payload: { print: { command: "clean_print_error", subtask_id: "0", print_type: "cloud" } },
  },
  // Set chamber temperature (X1/X1C)
  set_chamber_temp: {
    subKey: "print",
    payload: { print: { command: "set_ctt", ctt_val: 0 } },
  },
};

const SAFE_DEFAULT = ["light_on", "light_off", "speed_standard", "ams_filament", "pushall", "gcode_M105"];

router.post("/admin/metrics/printer/probe", requireAdmin, async (req, res) => {
  try {
    const { bambuUid, printerId, commands, timeoutMs = 4000 } = req.body || {};
    if (!bambuUid || !printerId) {
      return res.status(400).json({ ok: false, error: "Required: bambuUid, printerId" });
    }
    const list = Array.isArray(commands) && commands.length ? commands : SAFE_DEFAULT;
    const unknown = list.filter((n) => !PROBE_SUITE[n]);
    if (unknown.length) {
      return res.status(400).json({
        ok: false,
        error: `Unknown probe(s): ${unknown.join(", ")}. Available: ${Object.keys(PROBE_SUITE).join(", ")}`,
      });
    }

    const mqttService = require("../services/mqttPrinterService");
    const results = [];

    for (const name of list) {
      const spec = PROBE_SUITE[name];
      // deep clone so we don't mutate the suite definition
      const payload = JSON.parse(JSON.stringify(spec.payload));
      const r = await mqttService.probeCommand(String(bambuUid), printerId, payload, spec.subKey, Number(timeoutMs));
      const verdict = !r.sent
        ? "not_sent"
        : r.response == null
        ? "no_reply"
        : r.response.result === "success" || r.response.result === undefined
        ? "ok"
        : "rejected";
      results.push({
        name,
        subKey: spec.subKey,
        command: spec.payload[spec.subKey].command,
        sent: r.sent,
        seq: r.seq,
        verdict,
        took_ms: r.took_ms,
        result: r.response?.result ?? null,
        reason: r.response?.reason ?? null,
        response: r.response, // full echo for inspection
        error: r.error || null,
      });
      log.info(`[PROBE] ${name} → ${verdict} (took ${r.took_ms}ms${r.response?.reason ? `, reason="${r.response.reason}"` : ""})`);
      // Small breather between commands so we don't pile them on each other
      await new Promise((r) => setTimeout(r, 500));
    }

    res.json({
      ok: true,
      bambuUid,
      printerId,
      results,
      summary: {
        total: results.length,
        ok: results.filter((r) => r.verdict === "ok").length,
        no_reply: results.filter((r) => r.verdict === "no_reply").length,
        rejected: results.filter((r) => r.verdict === "rejected").length,
        not_sent: results.filter((r) => r.verdict === "not_sent").length,
      },
    });
  } catch (err) {
    log.error(`[ADMIN] probe error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
