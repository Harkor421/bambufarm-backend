const requireAdmin = require("../../middleware/adminAuth");
const log = require("../../utils/logger");

/* ─────────────────────────────────────────────────────────────────────────
 * Probe suite — sent in series by POST /admin/metrics/printer/probe to check
 * which Bambu cloud MQTT commands work without bridge signing.
 *
 * Each entry: { subKey, payload }. `payload[subKey].sequence_id` is filled
 * in by mqttService.probeCommand at send time.
 *
 * IMPORTANT: only run on an IDLE printer. pause/resume/stop would interrupt
 * an active print if Bambu actually accepts them.
 * ───────────────────────────────────────────────────────────────────── */
const PROBE_SUITE = {
  light_on: {
    subKey: "system",
    payload: {
      system: {
        command: "ledctrl",
        led_node: "chamber_light",
        led_mode: "on",
        led_on_time: 500,
        led_off_time: 500,
        loop_times: 0,
        interval_time: 0,
      },
    },
  },
  light_off: {
    subKey: "system",
    payload: {
      system: {
        command: "ledctrl",
        led_node: "chamber_light",
        led_mode: "off",
        led_on_time: 500,
        led_off_time: 500,
        loop_times: 0,
        interval_time: 0,
      },
    },
  },
  speed_standard: {
    subKey: "print",
    payload: { print: { command: "print_speed", param: "2" } },
  },
  ams_filament: {
    subKey: "print",
    payload: {
      print: {
        command: "ams_filament_setting",
        ams_id: 0,
        tray_id: 0,
        tray_color: "26FF9AFF",
        tray_type: "PLA",
        tray_info_idx: "GFL00",
        nozzle_temp_min: 190,
        nozzle_temp_max: 230,
      },
    },
  },
  // pushall is informational, not a control command — should always work
  pushall: {
    subKey: "pushing",
    payload: { pushing: { command: "pushall", version: 1, push_target: 1 } },
  },
  // Suspected to require signing
  pause: { subKey: "print", payload: { print: { command: "pause" } } },
  resume: { subKey: "print", payload: { print: { command: "resume" } } },
  stop: { subKey: "print", payload: { print: { command: "stop" } } },
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
    payload: {
      print: { command: "clean_print_error", subtask_id: "0", print_type: "cloud" },
    },
  },
  // Set chamber temperature (X1/X1C)
  set_chamber_temp: {
    subKey: "print",
    payload: { print: { command: "set_ctt", ctt_val: 0 } },
  },
};

const SAFE_DEFAULT = [
  "light_on",
  "light_off",
  "speed_standard",
  "ams_filament",
  "pushall",
  "gcode_M105",
];

/**
 * POST /api/admin/metrics/printer/ams-filament
 *   Test/manual endpoint to update an AMS slot's color + material via MQTT.
 *   Bambu only honors this when the printer is IDLE or PAUSE.
 *
 * GET /api/admin/metrics/printer/:bambuUid/:printerId/state
 *   Returns the full in-memory MQTT state for a printer (including AMS).
 *   Used to confirm whether commands sent via probe actually mutated state.
 *
 * POST /api/admin/metrics/printer/probe
 *   Probe which Bambu cloud MQTT commands work without bridge signing.
 *   See PROBE_SUITE above. response=null after timeout = silently dropped.
 */
module.exports = (router) => {
  router.post("/admin/metrics/printer/ams-filament", requireAdmin, async (req, res) => {
    try {
      const {
        bambuUid,
        printerId,
        amsId = 0,
        trayId,
        trayColor,
        trayType,
        trayInfoIdx,
        nozzleTempMin,
        nozzleTempMax,
      } = req.body || {};
      if (!bambuUid || !printerId || trayId == null || !trayColor || !trayType) {
        return res.status(400).json({
          ok: false,
          error: "Required: bambuUid, printerId, trayId, trayColor (RRGGBBAA hex), trayType",
        });
      }
      // The handler advertised "RRGGBBAA hex" but validated only presence, so
      // garbage (trayColor:"zzz", trayType:123) was forwarded verbatim to the
      // printer over MQTT, and Number() on non-numeric ids produced NaN. Validate
      // the color (6 or 8 hex digits) and guard the numeric coercions.
      if (!/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(String(trayColor))) {
        return res.status(400).json({ ok: false, error: "trayColor must be 6 or 8 hex digits (RRGGBB[AA])" });
      }
      const amsNum = Number(amsId);
      const trayNum = Number(trayId);
      const tempMin = nozzleTempMin != null ? Number(nozzleTempMin) : undefined;
      const tempMax = nozzleTempMax != null ? Number(nozzleTempMax) : undefined;
      if (
        !Number.isFinite(amsNum) ||
        !Number.isFinite(trayNum) ||
        (tempMin != null && !Number.isFinite(tempMin)) ||
        (tempMax != null && !Number.isFinite(tempMax))
      ) {
        return res.status(400).json({ ok: false, error: "amsId, trayId and nozzle temps must be numbers" });
      }
      const mqttService = require("../../services/mqttPrinterService");
      const sent = mqttService.setAmsFilament(String(bambuUid), printerId, {
        amsId: amsNum,
        trayId: trayNum,
        trayColor,
        trayType,
        trayInfoIdx,
        nozzleTempMin: tempMin,
        nozzleTempMax: tempMax,
      });
      if (!sent) {
        return res.status(503).json({
          ok: false,
          error: "MQTT not connected for this user — printer may be offline or user not registered",
        });
      }
      log.info(
        `[ADMIN] ams_filament_setting sent: uid=${bambuUid} printer=${printerId} ams=${amsId} tray=${trayId} color=${trayColor} type=${trayType}`
      );
      res.json({ ok: true, message: "Command sent — check the printer in 1-2 seconds" });
    } catch (err) {
      log.error(`[ADMIN] ams-filament error: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get(
    "/admin/metrics/printer/:bambuUid/:printerId/state",
    requireAdmin,
    (req, res) => {
      try {
        const { bambuUid, printerId } = req.params;
        const mqttService = require("../../services/mqttPrinterService");
        const state = mqttService.getPrinterState(String(bambuUid), printerId);
        if (!state) {
          return res.status(404).json({
            ok: false,
            error:
              "No MQTT state for this printer (user not connected or printer not seen yet)",
          });
        }
        res.json({ ok: true, bambuUid, printerId, state });
      } catch (err) {
        log.error(`[ADMIN] state error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
      }
    }
  );

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

      const mqttService = require("../../services/mqttPrinterService");
      const results = [];

      for (const name of list) {
        const spec = PROBE_SUITE[name];
        // deep clone so we don't mutate the suite definition
        const payload = JSON.parse(JSON.stringify(spec.payload));
        const r = await mqttService.probeCommand(
          String(bambuUid),
          printerId,
          payload,
          spec.subKey,
          Number(timeoutMs)
        );
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
          response: r.response,
          error: r.error || null,
        });
        log.info(
          `[PROBE] ${name} → ${verdict} (took ${r.took_ms}ms${r.response?.reason ? `, reason="${r.response.reason}"` : ""})`
        );
        // Small breather between commands so we don't pile them on each other
        await new Promise((r) => setTimeout(r, 500));
      }

      // Top-level ok reflects whether ANY command was actually sent. A probe
      // against a fully unreachable printer (every verdict "not_sent",
      // "no MQTT connection") is a failure, not a success — a monitor keying on
      // `ok` should not read a total no-op as green.
      res.json({
        ok: results.some((r) => r.sent),
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
};
