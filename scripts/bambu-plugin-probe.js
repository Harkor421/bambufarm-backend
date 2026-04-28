#!/usr/bin/env node
/**
 * Standalone Bambu plugin probe — runs in its own process so any plugin
 * crash/hang doesn't take down the main server. Spawned by the admin
 * /probe-via-plugin endpoint via child_process.execFile with a strict
 * timeout. Reads a JSON config from argv[2], writes JSON result to stdout.
 *
 * Usage:
 *   node bambu-plugin-probe.js '{"accessToken":"...","refreshToken":"...","uid":"...","printerId":"...","command":"print_speed"}'
 */

const fs = require("fs");
const path = require("path");

const arg = process.argv[2];
if (!arg) { console.log(JSON.stringify({ ok: false, error: "missing arg" })); process.exit(1); }
const cfg = JSON.parse(arg);

const result = { ok: true, diagnostics: [] };
const log = (k, v) => { result.diagnostics.push({ [k]: v }); process.stderr.write(`[probe] ${k}: ${JSON.stringify(v)}\n`); };

(async function main() {
  try {
    const { BambuAgent } = require(path.join(__dirname, "..", "src", "services", "bambuPluginAgent"));

    fs.mkdirSync("/tmp/bambu-agent-log/log", { recursive: true });
    fs.mkdirSync("/tmp/bambu-agent-config", { recursive: true });

    const agent = new BambuAgent();
    agent.events.onUserLogin = (online, login) => log("[CB] onUserLogin", { online, login });
    agent.events.onServerConnected = (rc, reason) => log("[CB] onServerConnected", { rc, reason });
    agent.events.onSubscribeFailure = (topic) => log("[CB] onSubscribeFailure", { topic });
    agent.events.onHttpError = (code, body) => log("[CB] onHttpError", { code, body: (body || "").slice(0, 400) });
    agent.events.onMessage = (devId, msg) => {
      if (msg.includes('"9999"')) log("[CB] RESP", { devId, msg: msg.slice(0, 500) });
    };

    log("create_agent", agent.create("/tmp/bambu-agent-log") || "ok");
    agent.registerCallbacks();
    log("set_country_code_callback", agent.setCountryCodeCallback("US"));
    log("init_log", agent.initLog());
    log("set_config_dir", agent.setConfigDir("/tmp/bambu-agent-config"));

    const bambuCertPath = path.join(__dirname, "..", "vendor", "bambu", "cert", "slicer_base64.cer");
    const certCandidates = [bambuCertPath, "/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem"];
    const certPath = certCandidates.find((p) => fs.existsSync(p));
    log("cert_path_used", certPath);
    agent.setCertFile(path.dirname(certPath), path.basename(certPath));

    // Skip set_extra_http_headers — koffi GCs the C strings after call,
    // plugin stores them as dangling pointers, segfault on next call.
    // Plugin works without these headers (Bambu only validates against
    // strict aes256 payload anyway, headers don't help).
    log("skipped_set_extra_http_headers", "to avoid koffi string lifetime bug");

    log("set_country_code", agent.setCountryCode("US"));
    log("enable_multi_machine", agent.enableMultiMachine(true));
    log("start", agent.start());
    log("change_user", agent.changeUser({
      accessToken: cfg.accessToken,
      refreshToken: cfg.refreshToken,
      uid: cfg.uid,
      account: cfg.account || "",
      name: cfg.name || "",
    }));
    log("is_user_login_immediately", agent.isUserLogin());
    log("connect_server", agent.connectServer());

    await new Promise((r) => setTimeout(r, 3000));

    log("is_user_login_after_3s", agent.isUserLogin());
    log("is_server_connected_after_3s", agent.isServerConnected());

    log("start_subscribe(app)", agent.startSubscribe("app"));
    const upi = agent.getUserPrintInfo();
    log("get_user_print_info", { http: upi.httpCode, body_len: upi.body.length, body_preview: upi.body.slice(0, 200) });

    log("install_device_cert", agent.fns.install_device_cert(agent.agentPtr, cfg.printerId, 0));
    log("update_cert", agent.updateCert());
    log("add_subscribe", agent.addSubscribe(cfg.printerId));
    log("set_user_selected_machine", agent.setUserSelectedMachine(cfg.printerId));

    await new Promise((r) => setTimeout(r, 1000));

    let cmd;
    if (cfg.command === "light_off") {
      cmd = { system: { sequence_id: "9999", command: "ledctrl", led_node: "chamber_light",
              led_mode: "off", led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } };
    } else if (cfg.command === "print_speed") {
      cmd = { print: { sequence_id: "9999", command: "print_speed", param: "2" } };
    } else if (cfg.command === "pause") {
      cmd = { print: { sequence_id: "9999", command: "pause", param: "" } };
    } else {
      cmd = { print: { sequence_id: "9999", command: "ams_filament_setting",
              ams_id: 0, tray_id: 0, tray_color: "FF00FFFF", tray_type: "PLA",
              tray_info_idx: "GFL00", nozzle_temp_min: 190, nozzle_temp_max: 230 } };
    }
    const sent = agent.sendCloudMessage(cfg.printerId, cmd, { qos: 1 });
    log("send_message_returned", sent);
    result.send_message_returned = sent;

    await new Promise((r) => setTimeout(r, 3000));

    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  } catch (e) {
    result.ok = false;
    result.error = e.message;
    result.stack = e.stack;
    process.stdout.write(JSON.stringify(result));
    process.exit(2);
  }
})();
