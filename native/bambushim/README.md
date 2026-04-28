# bambushim — Node.js wrapper for Bambu's signing plugin

**Status:** WIP — auth + cloud MQTT connection working; `send_message` blocked
on plugin-internal validation (returns -2). See "Known Blocker" below.

## What this is

A C++ shim + Node.js wrapper around Bambu Lab's closed-source
`libbambu_networking` plugin. The plugin contains the X.509 cert + private
key used to sign cloud MQTT commands — without it, Bambu rejects all control
commands sent to printers via cloud broker (only `light` works direct).

This shim lets us call into the plugin from Node so our backend can sign and
send commands like pause/resume/stop/ams_filament/calibration via cloud,
without requiring users to install the bridge.

## Architecture

```
Node.js (koffi FFI) → libbambushim.{dylib,so} (our shim) → libbambu_networking.{dylib,so} (Bambu's closed plugin)
```

The shim translates between FFI-friendly C types and the plugin's C++
`std::string` / `std::vector` / `std::function` parameters.

## Setup

```bash
# 1. Download the plugin binaries (~50MB Linux, ~90MB Mac)
./download-plugin.sh

# 2. Build the shim
./build.sh

# 3. Use from Node
node -e "const { BambuAgent } = require('../../src/services/bambuPluginAgent'); const a = new BambuAgent(); a.create('/tmp/log');"
```

## Verified working

- Plugin loads via `dlopen`
- All 107 exported `bambu_network_*` symbols resolve
- `change_user(token JSON)` — accepts our pre-existing tokens
- `connect_server` — completes TLS + auth handshake (`onServerConnected rc=0 reason=0`)
- `is_user_login` and `is_server_connected` both flip to true
- Cross-language callbacks fire (`OnUserLoginFn`, `OnServerConnectedFn`,
  `OnMessageFn` etc. wired through `koffi.register` → C function pointer →
  `std::function` lambda)
- `add_subscribe` and `start_subscribe` return 0
- `set_cert_file('/etc/ssl', 'cert.pem')` is REQUIRED for MQTT TLS to validate

## Final Finding: Plugin Refuses to Sign `print` Commands

After full callback wiring, `connect_printer`, `add_subscribe`, and
`set_user_selected_machine`, we confirmed:

| Command sub-key  | send_message result | Notes |
|------------------|---------------------|-------|
| `system/ledctrl` | ✅ → 0, response received | Plugin signs + Bambu accepts |
| `print/print_speed` | ❌ → -2 | Plugin refuses client-side |
| `print/pause`    | ❌ → -2 | Plugin refuses client-side |
| `print/stop`     | ❌ → -2 | Plugin refuses client-side |
| `print/ams_filament_setting` | ❌ → -2 | Plugin refuses client-side |
| `print/gcode_line` | ❌ → -2 | Plugin refuses client-side |

**Definitive test:** We replicated BambuStudio's *exact* code path verbatim
across multiple test rounds:
- `set_extra_http_header` with `X-BBL-Client-Type: slicer` etc.
- `start_subscribe("app")` (not "device")
- `qos=1` for control commands
- `pause` payload with `param: ""`
- `connect_printer` with both empty LAN params AND real access_code from
  `get_user_print_info`
- `set_user_selected_machine`
- `install_device_cert`
- `update_cert`
- `set_cert_file` with both `/etc/ssl/cert.pem` AND BambuStudio's official
  `slicer_base64.cer`
- Both plugin v01.10.00.07 (from 2023) AND v02.06.00.50 (current latest)
- Both legacy 4-arg ABI AND new 5-arg ABI for `send_message`

Every `print` sub-key command still returns -2. `system/ledctrl` still works
and printer responds with `result:"success"`.

**Root cause (identified via binary string analysis):** The plugin's signing
flow requires fetching a per-session `app_cert` from Bambu's HTTP endpoint:

```
GET https://api.bambulab.com/v1/iot-service/api/user/applications/slicer/cert?aes256=<encrypted_payload>&ver=1
```

The `aes256` query parameter is an **encrypted payload that only the official
Bambu Connect / signed BambuStudio binary knows how to construct**. Bambu's
server validates the payload format/signature — for any other request it
returns:

```
{"code":101,"error":"This application is outdated. Please update it to the latest version."}
```

This is what we get when calling that endpoint directly, regardless of
client headers (`X-BBL-Client-Version`, `User-Agent`, etc).

The plugin internally tries this fetch when start() runs and silently fails
when the response is "outdated". Without a valid app_cert, `add_sign_info`
(plugin internal) returns failure → `send_message` returns -2 for any
sub-key the plugin requires signing for (which is `print`, but not `system`).

**Diagnostic strings found in libbambu_networking.dylib:**
- `enc_msg: get_app_cert ok` / `enc_msg: get_app_cert failed`
- `enc_msg: app_cert is expired`
- `enc_msg: add sign info failed`
- `enc_msg: sign_string_internal failed!`
- `enc_msg: add_sign_info json is empty`

## Cert Chain Extracted (for reference)

Pulled all PEM-marked certificates out of `libbambu_networking.dylib`:

```
BBL CA (root, 2022-2032, CN=BBL CA, O=BBL Technologies Co. Ltd, C=CN)
├── BBL CA2 RSA (intermediate, 2025-2035)
├── BBL CA2 ECC (intermediate, 2025-2035)
├── application_root.bambulab.com (intermediate, 2024-2034)
│   ├── service.bambulab.com (server cert, 2024-2034)
│   └── GLOF3813734089.bambulab.com (slicer-app intermediate, 2024-2034)
│       └── GLOF3813734089-55c03bbf0000 (signing leaf cert, Dec 2025-Jun 2027)
```

The leaf cert `GLOF3813734089-55c03bbf0000` is what the plugin uses to sign
cloud MQTT `print` commands. The cert IS valid date-wise (2027-06-25) — so
expiration is not the immediate cause of -2.

## Why Cert Extraction Doesn't Solve It

The matching **private key** for the leaf signing cert is embedded but
**encrypted with PBKDF2-derived AES** (confirmed by strings `salt`, `iter`,
`PBKDF2` near `decrypt embeded_base64_encode_app_pri_key_str`). The
PBKDF2 password is itself embedded somewhere in the binary code (constant
in a function). Recovering it requires **runtime debugging** (lldb hook on
PKCS5_PBKDF2_HMAC) or deep static disassembly of the decrypt routine.

Even with the private key extracted, we'd also need to figure out:

1. The `aes256` payload format the plugin sends to
   `/v1/iot-service/api/user/applications/slicer/cert?aes256=...&ver=1`
   to refresh the cert when needed (server returns "outdated" otherwise).
2. The CRL (Certificate Revocation List) — also embedded encrypted as
   `embeded_app_crl_str`. Bambu may have **revoked the leaf cert in the
   embedded CRL** as a force-update mechanism, in which case the plugin
   refuses to use it even though it's date-valid.
3. The exact MQTT signing format — which fields go in `add_sign_info`,
   what gets HMAC'd vs RSA-signed, where the signature is appended.

**Estimated work to crack:** several days of focused RE with lldb +
Hopper/Ghidra. Outcome uncertain — even if all three above are solved,
Bambu can rotate the embedded keys in the next plugin release (~quarterly)
and break everything overnight.

**The realistic path remains BambuBridge.** The plugin is a dead-end for
backend-side automation regardless of how clever the FFI shim gets.

**For pause/resume/stop/ams/calibrate/etc., BambuBridge (LAN MQTT) remains
the only viable path.** The local broker accepts commands with `bblp` auth
without signing — same approach OrcaSlicer falls back to.

This matches the OrcaSlicer issue #9303 reports: third-party tools that used
to work for pause/resume stopped working after firmware updates, even though
they're using Bambu's official plugin via the same FFI patterns we did.

**For pause/resume/stop/ams/calibrate/etc., BambuBridge (LAN MQTT) remains
the only viable path.** The local broker accepts commands with `bblp` auth
without signing — same approach OrcaSlicer falls back to.

**This module is preserved** as a working FFI scaffold in case Bambu ever
relaxes the policy, or in case we discover a different signing path (e.g.,
the dedicated `start_print` workflow may still be exploitable for non-print
operations). For now it is not wired into any production code.

## Legal

The Bambu plugin binary is © Bambu Lab. Their EULA prohibits redistribution
and reverse-engineering. This integration is for our own backend use only;
the binaries are not bundled in client-distributed builds and not committed
to git (see `.gitignore`).
