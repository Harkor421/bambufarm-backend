/**
 * Probe whether Bambu Cloud MQTT accepts control commands from BambuFarm-style
 * auth vs. OrcaSlicer-style auth.
 *
 * What it does:
 *   1. Hits /v1/user-service/my/profile with the chosen header set to get the uid
 *   2. Connects MQTT to the cloud broker with u_<uid> / <access_token>
 *   3. Subscribes to device/<devId>/report
 *   4. Publishes a command and watches for the printer's echo (same sequence_id)
 *      and any gcode_state transition.
 *
 * Default command is `probe`, which sends a harmless read-only
 * {"system":{"command":"get_access_code"}} — the printer replies with the
 * access_code on its report topic. If THAT echo arrives, publishes work.
 *
 * Usage:
 *   # With a known-good access token:
 *   BAMBU_ACCESS_TOKEN=<token> DEV_ID=<dev_id> node test-bambu-control.js [command] [style]
 *
 *   # With a refresh token (script will exchange it for a fresh access token):
 *   BAMBU_REFRESH_TOKEN=<token> DEV_ID=<dev_id> node test-bambu-control.js [command] [style]
 *
 *   command : probe (default) | pause | resume | stop | pushall
 *   style   : orca (default)  | bambufarm
 *
 *   Optional env:
 *     BAMBU_REGION    us (default) | cn
 *     BAMBU_UID       override profile lookup
 *     TIMEOUT_MS      how long to wait for echo (default 8000)
 *
 * If only a refresh token is provided, OR if the access token returns 401,
 * the script will hit POST /v1/user-service/user/refresh to get a fresh one.
 */

const mqtt = require("mqtt");
const axios = require("axios");

let TOKEN = process.env.BAMBU_ACCESS_TOKEN || null;
const REFRESH_TOKEN = process.env.BAMBU_REFRESH_TOKEN || null;
const DEV_ID = process.env.DEV_ID;
const REGION = (process.env.BAMBU_REGION || "us").toLowerCase();
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "8000", 10);
const COMMAND = (process.argv[2] || "probe").toLowerCase();
const STYLE = (process.argv[3] || "orca").toLowerCase();

if ((!TOKEN && !REFRESH_TOKEN) || !DEV_ID) {
  console.error("Missing env. Provide either BAMBU_ACCESS_TOKEN or BAMBU_REFRESH_TOKEN, plus DEV_ID.");
  console.error("  BAMBU_ACCESS_TOKEN=<token> DEV_ID=<dev_id> node test-bambu-control.js [command] [style]");
  console.error("  BAMBU_REFRESH_TOKEN=<token> DEV_ID=<dev_id> node test-bambu-control.js [command] [style]");
  process.exit(1);
}
if (!["orca", "bambufarm"].includes(STYLE)) {
  console.error(`Unknown style "${STYLE}". Use orca | bambufarm`);
  process.exit(1);
}
const VALID_COMMANDS = [
  "probe",
  "pause",
  "resume",
  "stop",
  "pushall",
  "info",
  "hms-resume",
  "smart-resume",
  "clear-and-resume",
  "ams-resume",
  "ams-done",
  "ams-set",
  "light-on",
  "light-off",
];
if (!VALID_COMMANDS.includes(COMMAND)) {
  console.error(`Unknown command "${COMMAND}". Use one of: ${VALID_COMMANDS.join(" | ")}`);
  process.exit(1);
}

const API_HOST = REGION === "cn" ? "api.bambulab.cn" : "api.bambulab.com";
const MQTT_HOST = REGION === "cn" ? "cn.mqtt.bambulab.com" : "us.mqtt.bambulab.com";

const isOrca = STYLE === "orca";
const banner = `[${STYLE.toUpperCase()}] ${COMMAND} → ${DEV_ID} (${REGION})`;
console.log(`\n${"=".repeat(banner.length)}\n${banner}\n${"=".repeat(banner.length)}`);

async function refreshAccessToken(refreshToken) {
  console.log(`      POST /v1/user-service/user/refresh`);
  const r = await axios.post(
    `https://${API_HOST}/v1/user-service/user/refresh`,
    { refresh_token: refreshToken },
    { timeout: 15000, headers: { "Content-Type": "application/json" } }
  );
  const p = r.data?.data ?? r.data ?? {};
  const access = p.accessToken ?? p.access_token ?? p.access ?? null;
  const newRefresh = p.refreshToken ?? p.refresh_token ?? p.refresh ?? null;
  if (!access) throw new Error("refresh returned no access token: " + JSON.stringify(r.data).slice(0, 200));
  console.log(`      got fresh access token (len=${access.length})${newRefresh ? ` and new refresh token` : ""}`);
  return access;
}

(async () => {
  let uid = process.env.BAMBU_UID;

  // 0. If only refresh token given, exchange it first
  if (!TOKEN && REFRESH_TOKEN) {
    console.log(`\n[0/4] no access token provided — exchanging refresh token`);
    try {
      TOKEN = await refreshAccessToken(REFRESH_TOKEN);
    } catch (e) {
      console.error(`      refresh FAILED: ${e.response?.status || ""} ${e.message}`);
      if (e.response?.data) console.error(`      body: ${JSON.stringify(e.response.data).slice(0, 300)}`);
      process.exit(2);
    }
  }

  // 1. Profile fetch — also exercises the spoofed headers, and retries with refresh on 401
  if (!uid) {
    console.log(`\n[1/4] GET /v1/user-service/my/profile`);
    const buildHeaders = () => {
      const h = { Authorization: `Bearer ${TOKEN}` };
      if (isOrca) {
        h["X-BBL-Client-Type"] = "slicer";
        h["X-BBL-Client-Name"] = "BambuStudio";
        h["X-BBL-Client-Version"] = "01.10.02.50";
        h["X-BBL-OS-Type"] = "macos";
        h["User-Agent"] = "BambuStudio/01.10.02.50";
      }
      return h;
    };
    const tryProfile = async () =>
      axios.get(`https://${API_HOST}/v1/user-service/my/profile`, {
        headers: buildHeaders(),
        timeout: 10000,
      });
    let r;
    try {
      r = await tryProfile();
    } catch (e) {
      if (e.response?.status === 401 && REFRESH_TOKEN) {
        console.log(`      401 — exchanging refresh token and retrying`);
        try {
          TOKEN = await refreshAccessToken(REFRESH_TOKEN);
          r = await tryProfile();
        } catch (e2) {
          console.error(`      retry FAILED: ${e2.response?.status || ""} ${e2.message}`);
          if (e2.response?.data) console.error(`      body: ${JSON.stringify(e2.response.data).slice(0, 300)}`);
          process.exit(2);
        }
      } else {
        console.error(`      profile fetch FAILED: ${e.response?.status || ""} ${e.message}`);
        if (e.response?.data) console.error(`      body: ${JSON.stringify(e.response.data).slice(0, 300)}`);
        process.exit(2);
      }
    }
    uid = String(r.data?.uid ?? "");
    console.log(`      ok: uid=${uid} name=${r.data?.name || "?"} status=${r.status}`);
    if (!uid) {
      console.error("      profile response had no uid:", JSON.stringify(r.data).slice(0, 300));
      process.exit(2);
    }
  } else {
    console.log(`\n[1/4] using BAMBU_UID=${uid} from env, skipping profile fetch`);
  }

  // 2. MQTT connect
  console.log(`[2/4] mqtts://${MQTT_HOST}:8883`);
  const clientId = isOrca
    ? `bblp${uid}_${Math.random().toString(36).slice(2, 12)}`
    : `bambufarm_${uid}_${Date.now()}`;

  const client = mqtt.connect(`mqtts://${MQTT_HOST}:8883`, {
    username: `u_${uid}`,
    password: TOKEN,
    clientId,
    keepalive: 30,
    rejectUnauthorized: false,
    protocolVersion: 4,
    reconnectPeriod: 0, // single shot, no auto-reconnect
  });

  let lastGcodeState = null;
  let echoReceived = false;
  let echoMsg = null;
  let connectTime = 0;
  let printerSnapshot = {}; // accumulated push_status fields
  let snapshotReady = false; // becomes true after the first push_status with job_id

  // OrcaSlicer keeps sequence_id in [20000, 30000) — the printer treats this range
  // as "studio command" and may reject anything outside it.
  const sequenceId = String(20000 + Math.floor(Math.random() * 9999));
  const reportTopic = `device/${DEV_ID}/report`;
  const requestTopic = `device/${DEV_ID}/request`;

  client.on("connect", (connack) => {
    connectTime = Date.now();
    console.log(`      connected. clientId=${clientId}  sessionPresent=${connack.sessionPresent}`);
    // Try to also subscribe to the printer's REQUEST topic (the one we publish to).
    // OrcaSlicer's start_subscribe("app") might effectively subscribe to control echos.
    const extraSubs = (process.env.EXTRA_SUBS || "")
      .split(",")
      .map((s) => s.trim().replace("<UID>", uid).replace("<DEV>", DEV_ID))
      .filter(Boolean);
    const subs = [reportTopic, ...extraSubs];
    client.subscribe(subs, { qos: 1 }, (err, granted) => {
      if (err) {
        console.error(`      subscribe ERROR: ${err.message}`);
        return finish(false);
      }
      console.log(`      subscribed to ${subs.length} topics; granted:`);
      granted?.forEach((g) => console.log(`        ${g.topic}  qos=${g.qos}`));
      // For modes that need printer state, request a full pushall first.
      if (
        COMMAND === "info" ||
        COMMAND === "smart-resume" ||
        COMMAND === "hms-resume" ||
        COMMAND === "clear-and-resume"
      ) {
        const pushPayload = {
          pushing: { command: "pushall", push_target: 1, version: 1, sequence_id: sequenceId },
        };
        console.log(`      requesting full state via pushall…`);
        client.publish(requestTopic, JSON.stringify(pushPayload), { qos: 1 });
        // sendCommand() will be triggered when snapshot arrives
      } else {
        sendCommand();
      }
    });
  });

  client.on("message", (topic, payload) => {
    let msg;
    try {
      msg = JSON.parse(payload.toString());
    } catch {
      return;
    }

    // Merge any print.* fields into our snapshot
    if (msg.print && typeof msg.print === "object") {
      for (const [k, v] of Object.entries(msg.print)) {
        if (v !== null && v !== undefined) printerSnapshot[k] = v;
      }
    }

    const gs = msg.print?.gcode_state;
    if (gs && gs !== lastGcodeState) {
      console.log(`      [report] gcode_state: ${lastGcodeState ?? "(initial)"} → ${gs} at +${Date.now() - connectTime}ms`);
      lastGcodeState = gs;
    }
    const pct = msg.print?.mc_percent;
    if (pct !== undefined && pct !== printerSnapshot._lastPct) {
      console.log(`      [report] mc_percent=${pct}`);
      printerSnapshot._lastPct = pct;
    }

    const sysCmd = msg.system?.command;
    const printCmd = msg.print?.command;
    const sysSeq = msg.system?.sequence_id;
    const printSeq = msg.print?.sequence_id;

    if (sysCmd === "get_access_code" && msg.system?.access_code) {
      console.log(`      [echo] system.get_access_code → access_code=${msg.system.access_code} seq=${sysSeq}`);
      if (String(sysSeq) === sequenceId) {
        echoReceived = true;
        echoMsg = msg;
      }
    }

    if (printCmd && String(printSeq) === sequenceId) {
      echoReceived = true;
      echoMsg = msg;
      console.log(`      [echo] print.${printCmd} sequence_id=${printSeq} matched ours`);
    }

    // For info/smart-resume/hms-resume/clear-and-resume, trigger once snapshot is ready
    if (
      !snapshotReady &&
      (COMMAND === "info" ||
        COMMAND === "smart-resume" ||
        COMMAND === "hms-resume" ||
        COMMAND === "clear-and-resume")
    ) {
      const haveContext =
        (printerSnapshot.job_id || printerSnapshot.subtask_id || printerSnapshot.task_id) &&
        (printerSnapshot.gcode_state || printerSnapshot.print_error !== undefined);
      if (haveContext) {
        snapshotReady = true;
        if (COMMAND === "info") {
          dumpInfoAndExit();
        } else {
          sendCommand();
        }
      }
    }
  });

  client.on("error", (err) => {
    console.error(`      mqtt error: ${err.message}`);
  });

  client.on("close", () => {
    if (connectTime && Date.now() - connectTime < 1000) {
      console.error("      mqtt closed immediately after connect — broker likely rejected auth");
    }
  });

  function dumpInfoAndExit() {
    const hms = printerSnapshot.hms || [];
    console.log(`\n[INFO] printer snapshot:`);
    console.log(`      gcode_state       : ${printerSnapshot.gcode_state ?? "?"}`);
    console.log(`      job_id            : ${printerSnapshot.job_id ?? "?"}`);
    console.log(`      subtask_id        : ${printerSnapshot.subtask_id ?? "?"}`);
    console.log(`      task_id           : ${printerSnapshot.task_id ?? "?"}`);
    console.log(`      mc_percent        : ${printerSnapshot.mc_percent ?? "?"}`);
    console.log(`      remaining         : ${printerSnapshot.mc_remaining_time ?? "?"} min`);
    console.log(`      print_error       : ${printerSnapshot.print_error ?? "?"}`);
    console.log(`      mc_print_error_code: ${printerSnapshot.mc_print_error_code ?? "?"}`);
    console.log(`      HMS errors        : ${hms.length}`);
    for (const h of hms) {
      console.log(`        - attr=${h.attr} code=${h.code}  (hex: ${h.attr.toString(16)} ${h.code.toString(16)})`);
    }
    const activeErr =
      Number(printerSnapshot.print_error) ||
      Number(printerSnapshot.mc_print_error_code) ||
      null;
    const jobId =
      printerSnapshot.job_id || printerSnapshot.subtask_id || printerSnapshot.task_id;
    if (activeErr && jobId) {
      console.log(`\n      → resume payload will be:`);
      console.log(
        `        {"print":{"command":"resume","err":"${activeErr}","param":"reserve","job_id":"${jobId}","sequence_id":"…"}}`
      );
      console.log(`        run: node test-bambu-control.js smart-resume`);
    } else if (hms.length > 0) {
      console.log(`\n      → no print_error int in snapshot — only HMS attr/code pairs.`);
      console.log(
        `        Use 'pushall' or wait for a fuller report. If print_error stays empty,`
      );
      console.log(`        the printer may need 'ignore' + 'clean_print_error' commands instead.`);
    }
    try {
      client.end(true);
    } catch {}
    process.exit(0);
  }

  function formatHmsErrorString(h) {
    // OrcaSlicer/Studio format: attr and code are 32-bit ints; the error string
    // is "<attr_hi>_<attr_lo>_<code_hi>_<code_lo>" zero-padded to 4 hex chars each
    const hex = (n) => Number(n).toString(16).toUpperCase().padStart(8, "0");
    const attrHex = hex(h.attr);
    const codeHex = hex(h.code);
    return `${attrHex.slice(0, 4)}_${attrHex.slice(4)}_${codeHex.slice(0, 4)}_${codeHex.slice(4)}`;
  }

  function sendCommand() {
    const qos = isOrca ? 1 : 0;
    let payload;
    switch (COMMAND) {
      case "probe":
        payload = { system: { command: "get_access_code", sequence_id: sequenceId } };
        break;
      case "pause":
        payload = { print: { command: "pause", param: "", sequence_id: sequenceId } };
        break;
      case "resume":
        payload = { print: { command: "resume", param: "", sequence_id: sequenceId } };
        break;
      case "stop":
        payload = { print: { command: "stop", param: "", sequence_id: sequenceId } };
        break;
      case "pushall":
        payload = {
          pushing: { command: "pushall", push_target: 1, version: 1, sequence_id: sequenceId },
        };
        break;
      case "ams-resume":
        payload = { print: { command: "ams_control", param: "resume", sequence_id: sequenceId } };
        break;
      case "ams-done":
        payload = { print: { command: "ams_control", param: "done", sequence_id: sequenceId } };
        break;
      case "ams-set": {
        // Probe whether we can rewrite the color/type/temp of an AMS slot.
        // Same payload OrcaSlicer sends from its filament-settings dialog.
        //   AMS_ID         — which AMS unit (0 = first, 1 = second, …)
        //   SLOT_ID        — slot inside that AMS (0-3 on AMS, 0 on AMS Lite)
        //   TRAY_COLOR     — RRGGBBAA hex (e.g. "FF0000FF" = solid red)
        //   TRAY_TYPE      — PLA / PETG / ABS / TPU / PA / PC / ...
        //   TRAY_INFO_IDX  — Bambu filament SKU ("GFL00"=generic PLA, "GFA00"=Bambu PLA Basic …)
        //   TEMP_MIN/MAX   — nozzle temperature window
        const amsId = parseInt(process.env.AMS_ID || "0", 10);
        const slotId = parseInt(process.env.SLOT_ID || "0", 10);
        const trayColor = process.env.TRAY_COLOR || "26FF9AFF";
        const trayType = process.env.TRAY_TYPE || "PLA";
        const trayInfoIdx = process.env.TRAY_INFO_IDX || "GFL00";
        const tempMin = parseInt(process.env.TEMP_MIN || "190", 10);
        const tempMax = parseInt(process.env.TEMP_MAX || "240", 10);
        payload = {
          print: {
            sequence_id: sequenceId,
            command: "ams_filament_setting",
            ams_id: amsId,
            slot_id: slotId,
            tray_id: slotId,
            tray_info_idx: trayInfoIdx,
            setting_id: "",
            tray_color: trayColor,
            nozzle_temp_min: tempMin,
            nozzle_temp_max: tempMax,
            tray_type: trayType,
          },
        };
        break;
      }
      case "light-on":
      case "light-off":
        payload = {
          system: {
            sequence_id: sequenceId,
            command: "ledctrl",
            led_node: "chamber_light",
            led_mode: COMMAND === "light-on" ? "on" : "off",
            led_on_time: 500,
            led_off_time: 500,
            loop_times: 0,
            interval_time: 0,
          },
        };
        break;
      case "clear-and-resume": {
        const jobId =
          printerSnapshot.job_id ||
          printerSnapshot.subtask_id ||
          printerSnapshot.task_id ||
          process.env.JOB_ID;
        const activeErr =
          Number(process.env.HMS_ERR) ||
          Number(printerSnapshot.print_error) ||
          Number(printerSnapshot.mc_print_error_code) ||
          null;
        const subtaskId = printerSnapshot.subtask_id || jobId;
        if (!activeErr || !jobId) {
          console.error(`      no print_error/job_id — run 'info' first`);
          return finish(false);
        }
        const baseSeq = parseInt(sequenceId, 10);
        const seq = (off) => String(baseSeq + off);
        const hex8 = (n) => n.toString(16).toUpperCase().padStart(8, "0");
        // 4-command OrcaSlicer sequence to clear an error
        const commands = [
          { print: { command: "ignore", err: String(activeErr), param: "reserve", job_id: String(jobId), sequence_id: seq(0) } },
          { print: { command: "clean_print_error", subtask_id: String(subtaskId), print_error: activeErr, sequence_id: seq(1) } },
          { system: { command: "uiop", name: "print_error", action: "close", source: 1, type: "dialog", err: hex8(activeErr), sequence_id: seq(2) } },
          { pushing: { command: "pushall", push_target: 1, version: 1, sequence_id: seq(3) } },
        ];
        console.log(`[3/4] firing 4-command clear sequence (err=${activeErr}, job=${jobId})`);
        commands.forEach((p, i) => {
          console.log(`      [${i}] ${JSON.stringify(p)}`);
          client.publish(requestTopic, JSON.stringify(p), { qos: 1 });
        });
        // Listen for ~10s for state changes, then exit
        setTimeout(() => finish(true), TIMEOUT_MS);
        return;
      }
      case "hms-resume":
      case "smart-resume": {
        const jobId =
          printerSnapshot.job_id ||
          printerSnapshot.subtask_id ||
          printerSnapshot.task_id ||
          process.env.JOB_ID;
        const activeErr =
          process.env.HMS_ERR ||
          Number(printerSnapshot.print_error) ||
          Number(printerSnapshot.mc_print_error_code) ||
          null;
        if (!activeErr || !jobId) {
          console.error(`      no print_error or no job_id in snapshot — cannot build hms_resume`);
          console.error(`      print_error=${printerSnapshot.print_error} mc_print_error_code=${printerSnapshot.mc_print_error_code} job_id=${jobId}`);
          console.error(`      run 'node test-bambu-control.js info' to inspect printer state`);
          return finish(false);
        }
        const errStr = String(activeErr);
        console.log(`      using err="${errStr}" (decimal print_error), job_id="${jobId}"`);
        payload = {
          print: {
            command: "resume",
            err: errStr,
            param: "reserve",
            job_id: String(jobId),
            sequence_id: sequenceId,
          },
        };
        break;
      }
    }

    console.log(`[3/4] publish ${requestTopic} qos=${qos} seq=${sequenceId}`);
    console.log(`      payload: ${JSON.stringify(payload)}`);

    client.publish(requestTopic, JSON.stringify(payload), { qos }, (err) => {
      if (err) {
        console.error(`      publish ERROR: ${err.message}`);
        return finish(false);
      }
      console.log(
        `      publish ${qos > 0 ? "ACKed by broker (QoS 1 puback)" : "sent (QoS 0, no ack)"}`
      );
      console.log(`      waiting ${TIMEOUT_MS}ms for printer echo on ${reportTopic}…`);
    });

    setTimeout(() => finish(true), TIMEOUT_MS);
  }

  function finish(ok) {
    console.log(`\n[4/4] RESULT`);
    console.log(`      style              : ${STYLE}`);
    console.log(`      command            : ${COMMAND}`);
    console.log(`      mqtt clientId      : ${clientId}`);
    console.log(`      mqtt qos           : ${isOrca ? 1 : 0}`);
    console.log(`      orca headers used  : ${isOrca ? "yes" : "no"}`);
    console.log(`      printer echoed seq : ${echoReceived ? "YES ✓" : "NO ✗"}`);
    console.log(`      final gcode_state  : ${lastGcodeState ?? "(no report received)"}`);
    if (echoMsg) {
      console.log(`      echo payload       : ${JSON.stringify(echoMsg).slice(0, 400)}`);
    }
    if (!echoReceived && COMMAND === "probe") {
      console.log(
        `\n      Interpretation: subscribe works (you'd otherwise see no reports either),`
      );
      console.log(`      but publishes to device/<id>/request are being silently dropped.`);
      console.log(`      That's the auth-gating you suspected — Bambu's cloud broker accepts`);
      console.log(`      this account's reads but not its writes.`);
    } else if (echoReceived && COMMAND === "probe") {
      console.log(`\n      Interpretation: publishes ARE accepted. Pause/resume should work too.`);
      console.log(`      Re-run with: node test-bambu-control.js pause   (on an active print)`);
    }
    try {
      client.end(true);
    } catch {}
    process.exit(echoReceived ? 0 : 10);
  }

  process.on("SIGINT", () => {
    console.log("\n(interrupted)");
    try {
      client.end(true);
    } catch {}
    process.exit(130);
  });
})();
