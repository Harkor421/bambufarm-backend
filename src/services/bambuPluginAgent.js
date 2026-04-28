/**
 * BambuPluginAgent — Node.js wrapper around Bambu's libbambu_networking
 * (the closed-source signing plugin that BambuStudio and OrcaSlicer use).
 *
 * Loads our libbambushim.dylib/.so wrapper, which in turn dlopen()s Bambu's
 * libbambu_networking and provides a C-friendly API. See
 * native/bambushim/bambushim.cpp for the layer in between.
 *
 * Status: PROOF OF CONCEPT. Only enough plumbing to verify we can:
 *   1. Load the shim + plugin without crashing
 *   2. Create an agent instance
 *   3. (Eventually) connect + send a signed cloud MQTT message
 *
 * Legal note: the Bambu plugin's EULA restricts redistribution. This module
 * is for our own backend use only and the .so/.dylib is not bundled in
 * client-distributed builds.
 */

const path = require("path");
const fs = require("fs");
const koffi = require("koffi");

// ── Locate the right shim binary for this platform ────────────────────────
const shimDir = path.join(__dirname, "..", "..", "native", "bambushim");
const platform = process.platform;
const shimFilename =
  platform === "darwin" ? "libbambushim.dylib" :
  platform === "linux" ? "libbambushim.so" :
  null;
if (!shimFilename) {
  throw new Error(`bambuPluginAgent: unsupported platform ${platform}`);
}
const shimPath = path.join(shimDir, shimFilename);

let lib;
function loadLib() {
  if (lib) return lib;
  if (!fs.existsSync(shimPath)) {
    throw new Error(`bambuPluginAgent: shim not built at ${shimPath} — run server/native/bambushim/build.sh first`);
  }
  lib = koffi.load(shimPath);
  return lib;
}

// ── Bind shim functions ────────────────────────────────────────────────────
// All shim_* signatures use C-friendly types: void*, const char*, int.
let bound = null;
function bind() {
  if (bound) return bound;
  const l = loadLib();
  bound = {
    create_agent:           l.func("void* shim_create_agent(const char* log_dir)"),
    destroy_agent:          l.func("int   shim_destroy_agent(void* agent)"),
    init_log:               l.func("int   shim_init_log(void* agent)"),
    set_config_dir:         l.func("int   shim_set_config_dir(void* agent, const char* dir)"),
    set_country_code:       l.func("int   shim_set_country_code(void* agent, const char* code)"),
    set_cert_file:          l.func("int   shim_set_cert_file(void* agent, const char* folder, const char* filename)"),
    start:                  l.func("int   shim_start(void* agent)"),
    connect_server:         l.func("int   shim_connect_server(void* agent)"),
    is_server_connected:    l.func("int   shim_is_server_connected(void* agent)"),
    connect_printer:        l.func("int   shim_connect_printer(void* agent, const char* dev_id, const char* dev_ip, const char* username, const char* password, int use_ssl)"),
    disconnect_printer:     l.func("int   shim_disconnect_printer(void* agent)"),
    send_message:           l.func("int   shim_send_message(void* agent, const char* dev_id, const char* json_str, int qos)"),
    send_message_v5:        l.func("int   shim_send_message_v5(void* agent, const char* dev_id, const char* json_str, int qos, int flag)"),
    send_message_to_printer:l.func("int   shim_send_message_to_printer(void* agent, const char* dev_id, const char* json_str, int qos, int flag)"),
    install_device_cert:    l.func("void  shim_install_device_cert(void* agent, const char* dev_id, int lan_only)"),
    is_user_login:          l.func("int   shim_is_user_login(void* agent)"),
    refresh_connection:     l.func("int   shim_refresh_connection(void* agent)"),
    get_my_profile:         l.func("int   shim_get_my_profile(void* agent, const char* token, char* out_body, int out_body_size)"),
    change_user:            l.func("int   shim_change_user(void* agent, const char* user_info_json)"),
    set_on_user_login_fn:        l.func("int shim_set_on_user_login_fn(void* agent, void* cb)"),
    set_on_server_connected_fn:  l.func("int shim_set_on_server_connected_fn(void* agent, void* cb)"),
    set_on_printer_connected_fn: l.func("int shim_set_on_printer_connected_fn(void* agent, void* cb)"),
    set_on_message_fn:           l.func("int shim_set_on_message_fn(void* agent, void* cb)"),
    set_on_http_error_fn:        l.func("int shim_set_on_http_error_fn(void* agent, void* cb)"),
    set_country_code_callback:   l.func("int shim_set_country_code_callback(void* agent, const char* code)"),
    start_subscribe:             l.func("int shim_start_subscribe(void* agent, const char* module)"),
    stop_subscribe:              l.func("int shim_stop_subscribe(void* agent, const char* module)"),
    enable_multi_machine:        l.func("void shim_enable_multi_machine(void* agent, int enable)"),
    add_subscribe_one:           l.func("int shim_add_subscribe_one(void* agent, const char* dev_id)"),
    del_subscribe_one:           l.func("int shim_del_subscribe_one(void* agent, const char* dev_id)"),
    set_user_selected_machine:   l.func("int shim_set_user_selected_machine(void* agent, const char* dev_id)"),
    set_on_subscribe_failure_fn: l.func("int shim_set_on_subscribe_failure_fn(void* agent, void* cb)"),
    set_extra_http_headers:      l.func("int shim_set_extra_http_headers(void* agent, const char** kv_pairs, int count)"),
    get_user_print_info:         l.func("int shim_get_user_print_info(void* agent, char* out_body, int out_body_size)"),
    update_cert:                 l.func("int shim_update_cert(void* agent)"),
  };

  // koffi callback prototypes — must match the C typedefs in bambushim.cpp.
  bound._cbProto = {
    onUserLogin:        koffi.proto("on_user_login_t", "void", ["int", "int"]),
    onServerConnected:  koffi.proto("on_server_connected_t", "void", ["int", "int"]),
    onPrinterConnected: koffi.proto("on_printer_connected_t", "void", ["str"]),
    onMessage:          koffi.proto("on_message_t", "void", ["str", "str"]),
    onHttpError:        koffi.proto("on_http_error_t", "void", ["uint", "str"]),
    onSubscribeFailure: koffi.proto("on_subscribe_failure_t", "void", ["str"]),
  };
  return bound;
}

// ── Public API ─────────────────────────────────────────────────────────────

class BambuAgent {
  constructor() {
    this.agentPtr = null;
    this.fns = bind();
    this._cbHandles = []; // keep callback registrations alive (GC root)
    this.events = {
      onUserLogin: null,
      onServerConnected: null,
      onPrinterConnected: null,
      onMessage: null,
      onHttpError: null,
      onSubscribeFailure: null,
    };
  }

  /** Register the bridging callbacks with the plugin. Call BEFORE start(). */
  registerCallbacks() {
    const reg = (name, proto, dispatch) => {
      const ptr = koffi.register(dispatch, koffi.pointer(proto));
      this._cbHandles.push(ptr); // prevent GC
      return ptr;
    };
    const ptrUL = reg("onUserLogin", this.fns._cbProto.onUserLogin,
      (online, login) => {
        try { this.events.onUserLogin && this.events.onUserLogin(online, login); }
        catch (e) { console.error("[bambuPluginAgent] onUserLogin handler:", e.message); }
      });
    const ptrSC = reg("onServerConnected", this.fns._cbProto.onServerConnected,
      (rc, reason) => {
        try { this.events.onServerConnected && this.events.onServerConnected(rc, reason); }
        catch (e) { console.error("[bambuPluginAgent] onServerConnected handler:", e.message); }
      });
    const ptrPC = reg("onPrinterConnected", this.fns._cbProto.onPrinterConnected,
      (topic) => {
        try { this.events.onPrinterConnected && this.events.onPrinterConnected(topic); }
        catch (e) { console.error("[bambuPluginAgent] onPrinterConnected handler:", e.message); }
      });
    const ptrM = reg("onMessage", this.fns._cbProto.onMessage,
      (devId, msg) => {
        try { this.events.onMessage && this.events.onMessage(devId, msg); }
        catch (e) { console.error("[bambuPluginAgent] onMessage handler:", e.message); }
      });
    const ptrHE = reg("onHttpError", this.fns._cbProto.onHttpError,
      (code, body) => {
        try { this.events.onHttpError && this.events.onHttpError(code, body); }
        catch (e) { console.error("[bambuPluginAgent] onHttpError handler:", e.message); }
      });

    const ptrSF = reg("onSubscribeFailure", this.fns._cbProto.onSubscribeFailure,
      (topic) => {
        try { this.events.onSubscribeFailure && this.events.onSubscribeFailure(topic); }
        catch (e) { console.error("[bambuPluginAgent] onSubscribeFailure handler:", e.message); }
      });

    this.fns.set_on_user_login_fn(this.agentPtr, ptrUL);
    this.fns.set_on_server_connected_fn(this.agentPtr, ptrSC);
    this.fns.set_on_printer_connected_fn(this.agentPtr, ptrPC);
    this.fns.set_on_message_fn(this.agentPtr, ptrM);
    this.fns.set_on_http_error_fn(this.agentPtr, ptrHE);
    this.fns.set_on_subscribe_failure_fn(this.agentPtr, ptrSF);
  }

  /** Set the country-code provider — plugin asks via callback synchronously. */
  setCountryCodeCallback(code) {
    return this.fns.set_country_code_callback(this.agentPtr, code);
  }

  startSubscribe(module = "device")  { return this.fns.start_subscribe(this.agentPtr, module); }
  stopSubscribe(module = "device")   { return this.fns.stop_subscribe(this.agentPtr, module); }
  enableMultiMachine(enable = true)  { return this.fns.enable_multi_machine(this.agentPtr, enable ? 1 : 0); }
  addSubscribe(devId)                { return this.fns.add_subscribe_one(this.agentPtr, devId); }
  delSubscribe(devId)                { return this.fns.del_subscribe_one(this.agentPtr, devId); }
  setUserSelectedMachine(devId)      { return this.fns.set_user_selected_machine(this.agentPtr, devId); }

  updateCert() { return this.fns.update_cert(this.agentPtr); }

  /** Fetch user's owned printer list — REQUIRED for send_message of print
   *  commands to work. Plugin uses internal list to validate device ownership. */
  getUserPrintInfo() {
    const buf = Buffer.alloc(256 * 1024);
    const httpCode = this.fns.get_user_print_info(this.agentPtr, buf, buf.length);
    const nul = buf.indexOf(0);
    return { httpCode, body: buf.slice(0, nul >= 0 ? nul : buf.length).toString("utf8") };
  }

  /** Set HTTP headers like BambuStudio does — X-BBL-Client-Type=slicer, etc.
   *  Without these, Bambu may treat us as an unauthorized client. */
  setExtraHttpHeaders(headers) {
    const entries = Object.entries(headers);
    const flat = [];
    for (const [k, v] of entries) { flat.push(k); flat.push(String(v)); }
    // koffi expects a pointer-to-array of strings
    const arr = koffi.alloc("char*", flat.length);
    for (let i = 0; i < flat.length; i++) {
      koffi.encode(arr, i * koffi.sizeof("char*"), "char*", flat[i]);
    }
    return this.fns.set_extra_http_headers(this.agentPtr, arr, entries.length);
  }

  /**
   * Create the underlying network agent instance. `logDir` is where the
   * plugin writes its own logs — pass any writable path.
   */
  create(logDir) {
    if (this.agentPtr) return;
    this.agentPtr = this.fns.create_agent(logDir);
    if (!this.agentPtr) throw new Error("bambu_network_create_agent returned null");
  }

  initLog()              { return this.fns.init_log(this.agentPtr); }
  setConfigDir(dir)      { return this.fns.set_config_dir(this.agentPtr, dir); }
  setCountryCode(code)   { return this.fns.set_country_code(this.agentPtr, code); }
  setCertFile(folder, f) { return this.fns.set_cert_file(this.agentPtr, folder, f); }
  start()                { return this.fns.start(this.agentPtr); }
  connectServer()        { return this.fns.connect_server(this.agentPtr); }
  isServerConnected()    { return !!this.fns.is_server_connected(this.agentPtr); }

  /**
   * Send a JSON command via cloud MQTT. The plugin signs it with the
   * embedded device cert before publishing — this is the whole point.
   * Uses the LEGACY 4-arg ABI by default (matches OrcaSlicer behavior, since
   * NetworkAgent::use_legacy_network defaults to true).
   */
  sendCloudMessage(devId, json, { qos = 1 } = {}) {
    const payload = typeof json === "string" ? json : JSON.stringify(json);
    return this.fns.send_message(this.agentPtr, devId, payload, qos);
  }

  isUserLogin()              { return !!this.fns.is_user_login(this.agentPtr); }
  refreshConnection()        { return this.fns.refresh_connection(this.agentPtr); }

  /**
   * Inject existing tokens (already obtained via your own OAuth flow) into
   * the plugin so it can authenticate without going through its own login UI.
   * Format reverse-engineered from OrcaSlicer's HttpServer.cpp.
   *
   * @param {Object} creds
   * @param {string} creds.accessToken
   * @param {string} creds.refreshToken
   * @param {string|number} [creds.expiresIn]        seconds until access token expires
   * @param {string|number} [creds.refreshExpiresIn] seconds until refresh token expires
   * @param {string} creds.uid                       Bambu user id
   * @param {string} [creds.name]                    display name
   * @param {string} [creds.account]                 email/phone
   * @param {string} [creds.avatar]                  avatar URL
   */
  changeUser(creds) {
    // Format reverse-engineered from jarczak's BridgeAuthPayload.hpp
    // normalize_change_user_payload(): the plugin REQUIRES `command: "user_login"`
    // at the top level. Without this, the plugin treats the auth state as
    // unauthenticated and the cert/sign flow silently fails (-2 on send_message).
    const payload = {
      command: "user_login",
      data: {
        token: creds.accessToken,
        refresh_token: creds.refreshToken,
        expires_in: String(creds.expiresIn ?? 86400),
        refresh_expires_in: String(creds.refreshExpiresIn ?? 2592000),
        user: {
          uid: String(creds.uid),
          name: creds.name || "",
          account: creds.account || "",
          avatar: creds.avatar || "",
        },
      },
    };
    return this.fns.change_user(this.agentPtr, JSON.stringify(payload));
  }

  /** Calls the plugin's HTTP profile endpoint with our access_token. Returns
   *  { httpCode, body }. Useful to verify the token works against Bambu cloud
   *  before attempting MQTT auth. */
  getMyProfile(accessToken) {
    const buf = Buffer.alloc(65536);
    const httpCode = this.fns.get_my_profile(this.agentPtr, accessToken, buf, buf.length);
    const nul = buf.indexOf(0);
    return { httpCode, body: buf.slice(0, nul >= 0 ? nul : buf.length).toString("utf8") };
  }

  destroy() {
    if (!this.agentPtr) return;
    this.fns.destroy_agent(this.agentPtr);
    this.agentPtr = null;
  }
}

module.exports = { BambuAgent, shimPath };
