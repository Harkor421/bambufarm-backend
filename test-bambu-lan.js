/**
 * LAN-mode test: discover a Bambu printer on the local network via the
 * SSDP-style UDP broadcast (255.255.255.255:2021), then connect MQTT
 * directly to it and send a command.
 *
 * Usage:
 *   DEV_ID=<dev_id> ACCESS_CODE=<8-digit> node test-bambu-lan.js [command]
 *     command : info (default) | pause | resume | stop | probe
 *
 * If ACCESS_CODE is not provided we'll discover the IP, then ask Bambu
 * Cloud's bind API for the dev_access_code (requires BAMBU_ACCESS_TOKEN).
 */

const dgram = require("dgram");
const mqtt = require("mqtt");

const DEV_ID = process.env.DEV_ID;
const ACCESS_CODE = process.env.ACCESS_CODE;
const COMMAND = (process.argv[2] || "info").toLowerCase();
const DISCOVER_TIMEOUT_MS = parseInt(process.env.DISCOVER_TIMEOUT_MS || "8000", 10);
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "10000", 10);

if (!DEV_ID || !ACCESS_CODE) {
  console.error("Missing env. Required: DEV_ID, ACCESS_CODE");
  console.error("  DEV_ID=<id> ACCESS_CODE=<8-digit> node test-bambu-lan.js [command]");
  process.exit(1);
}

const VALID = ["info", "pause", "resume", "stop", "probe", "ams-set", "ledctrl"];
if (!VALID.includes(COMMAND)) {
  console.error(`Unknown command "${COMMAND}". Use: ${VALID.join(" | ")}`);
  process.exit(1);
}

console.log(`\n[LAN] ${COMMAND} → ${DEV_ID}`);
console.log("=".repeat(40));

function discoverPrinterIp(targetDevId) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let resolved = false;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { sock.close(); } catch {}
      reject(new Error(`SSDP discovery timeout after ${DISCOVER_TIMEOUT_MS}ms`));
    }, DISCOVER_TIMEOUT_MS);

    sock.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      reject(err);
    });

    sock.on("message", (buf, rinfo) => {
      const msg = buf.toString("utf8");
      // Bambu's NOTIFY packet has USN: <dev_id> and Location: <ip>
      const usn = /^USN:\s*(\S+)/im.exec(msg)?.[1];
      const loc = /^Location:\s*(\S+)/im.exec(msg)?.[1];
      const model = /^DevModel\.bambu\.com:\s*(\S+)/im.exec(msg)?.[1];
      if (usn) {
        console.log(`      [ssdp] ${usn}  ip=${loc || rinfo.address}  model=${model || "?"}`);
        if (usn === targetDevId) {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          const ip = loc || rinfo.address;
          try { sock.close(); } catch {}
          resolve(ip);
        }
      }
    });

    sock.bind(2021, () => {
      try { sock.setBroadcast(true); } catch {}
      console.log(`[1/3] listening on UDP 0.0.0.0:2021 for SSDP NOTIFY (printers broadcast every ~5s)`);
    });
  });
}

async function main() {
  let ip;
  try {
    ip = await discoverPrinterIp(DEV_ID);
    console.log(`      found ${DEV_ID} at ${ip}`);
  } catch (e) {
    console.error(`      discovery failed: ${e.message}`);
    console.error(`      Either:`);
    console.error(`        - this machine isn't on the same LAN as the printer`);
    console.error(`        - or your firewall is blocking UDP 2021`);
    console.error(`      If you know the IP, pass it via LAN_IP env and re-run.`);
    if (process.env.LAN_IP) {
      ip = process.env.LAN_IP;
      console.log(`      using LAN_IP=${ip} from env`);
    } else {
      process.exit(2);
    }
  }

  console.log(`[2/3] mqtts://${ip}:8883 as bblp / <access_code>`);
  // Random Studio-like client ID. Bambu's printer firmware accepts any
  // unique string here; open-bamboo-networking uses "obn-<hex>-<time>".
  const clientId = `obn-${Math.random().toString(16).slice(2, 18)}-${Date.now()}`;

  const client = mqtt.connect(`mqtts://${ip}:8883`, {
    username: "bblp",
    password: ACCESS_CODE,
    clientId,
    keepalive: 30,
    rejectUnauthorized: false, // printer presents a self-signed cert
    protocolVersion: 4,
    reconnectPeriod: 0,
    connectTimeout: 10000,
  });

  let snapshot = {};
  let echoReceived = false;
  let echoMsg = null;
  let lastGcodeState = null;
  // OrcaSlicer uses sequence_id in [20000, 30000)
  const sequenceId = String(20000 + Math.floor(Math.random() * 9999));
  const reportTopic = `device/${DEV_ID}/report`;
  const requestTopic = `device/${DEV_ID}/request`;

  client.on("error", (err) => console.error(`      mqtt error: ${err.message}`));
  client.on("close", () => console.log(`      mqtt closed`));

  client.on("connect", () => {
    console.log(`      connected (clientId=${clientId})`);
    client.subscribe(reportTopic, { qos: 1 }, (err, granted) => {
      if (err) {
        console.error(`      subscribe failed: ${err.message}`);
        return process.exit(3);
      }
      console.log(`      subscribed to ${reportTopic} qos=${granted?.[0]?.qos}`);
      sendCommand();
    });
  });

  client.on("message", (topic, payload) => {
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch { return; }
    if (msg.print && typeof msg.print === "object") {
      for (const [k, v] of Object.entries(msg.print)) {
        if (v !== null && v !== undefined) snapshot[k] = v;
      }
    }
    const gs = msg.print?.gcode_state;
    if (gs && gs !== lastGcodeState) {
      console.log(`      [report] gcode_state: ${lastGcodeState ?? "(initial)"} → ${gs}`);
      lastGcodeState = gs;
    }
    const sysSeq = msg.system?.sequence_id;
    const printSeq = msg.print?.sequence_id;
    if (msg.system?.command === "get_access_code" && String(sysSeq) === sequenceId) {
      echoReceived = true;
      echoMsg = msg;
      console.log(`      [echo] get_access_code → ${msg.system.access_code} seq=${sysSeq}`);
    }
    if (msg.print?.command && String(printSeq) === sequenceId) {
      echoReceived = true;
      echoMsg = msg;
      console.log(`      [echo] print.${msg.print.command} seq=${printSeq}  err_code=${msg.print.err_code ?? 0}`);
    }
  });

  function sendCommand() {
    let payload;
    switch (COMMAND) {
      case "info":
        payload = { pushing: { command: "pushall", push_target: 1, version: 1, sequence_id: sequenceId } };
        break;
      case "probe":
        payload = { system: { command: "get_access_code", sequence_id: sequenceId } };
        break;
      case "pause": {
        const p = { command: "pause", param: "", sequence_id: sequenceId };
        if (process.env.JOB_ID) p.job_id = process.env.JOB_ID;
        payload = { print: p };
        break;
      }
      case "resume": {
        const p = { command: "resume", param: "", sequence_id: sequenceId };
        if (process.env.JOB_ID) p.job_id = process.env.JOB_ID;
        payload = { print: p };
        break;
      }
      case "stop": {
        const p = { command: "stop", param: "", sequence_id: sequenceId };
        if (process.env.JOB_ID) p.job_id = process.env.JOB_ID;
        payload = { print: p };
        break;
      }
      case "ams-set": {
        const amsId = parseInt(process.env.AMS_ID || "0", 10);
        const slotId = parseInt(process.env.SLOT_ID || "0", 10);
        const trayColor = process.env.TRAY_COLOR || "26FF9AFF"; // RGBA
        const trayType = process.env.TRAY_TYPE || "PLA";
        const trayInfoIdx = process.env.TRAY_INFO_IDX || "GFL00"; // generic PLA
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
      case "ledctrl":
        payload = {
          system: {
            sequence_id: sequenceId,
            command: "ledctrl",
            led_node: "chamber_light",
            led_mode: process.env.LED_MODE || "on",
            led_on_time: 500,
            led_off_time: 500,
            loop_times: 0,
            interval_time: 0,
          },
        };
        break;
    }
    console.log(`[3/3] publish ${requestTopic} seq=${sequenceId}`);
    console.log(`      payload: ${JSON.stringify(payload)}`);
    client.publish(requestTopic, JSON.stringify(payload), { qos: 1 }, (err) => {
      if (err) {
        console.error(`      publish error: ${err.message}`);
        return process.exit(4);
      }
      console.log(`      published (QoS 1 ACKed by printer broker)`);
      console.log(`      waiting ${TIMEOUT_MS}ms for echo / state updates…`);
    });

    setTimeout(() => {
      console.log(`\n[RESULT]`);
      console.log(`      lan_ip          : ${ip}`);
      console.log(`      command         : ${COMMAND}`);
      console.log(`      echo received   : ${echoReceived ? "YES ✓" : "NO ✗"}`);
      console.log(`      final gcode_state: ${lastGcodeState ?? "(none)"}`);
      if (echoMsg) console.log(`      echo: ${JSON.stringify(echoMsg).slice(0, 300)}`);
      if (COMMAND === "info") {
        console.log(`      snapshot fields collected:`);
        console.log(`        gcode_state=${snapshot.gcode_state}  mc_percent=${snapshot.mc_percent}  print_error=${snapshot.print_error}`);
        console.log(`        subtask_id=${snapshot.subtask_id}  job_id=${snapshot.job_id}`);
        console.log(`        hms=${JSON.stringify(snapshot.hms || [])}`);
        console.log(`        lights_report=${JSON.stringify(snapshot.lights_report || [])}`);
        console.log(`        nozzle_temp=${snapshot.nozzle_temper}  bed_temp=${snapshot.bed_temper}`);
        console.log(`        spd_lvl=${snapshot.spd_lvl}  spd_mag=${snapshot.spd_mag}`);
        if (snapshot.ams) console.log(`        ams=${JSON.stringify(snapshot.ams).slice(0, 300)}`);
      }
      try { client.end(true); } catch {}
      process.exit(echoReceived || COMMAND === "info" ? 0 : 10);
    }, TIMEOUT_MS);
  }

  process.on("SIGINT", () => {
    try { client.end(true); } catch {}
    process.exit(130);
  });
}

main();
