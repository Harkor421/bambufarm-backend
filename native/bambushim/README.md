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

**Conclusion:** Bambu's "Authorization Control System" (rolled out in 2024
firmware updates) **hardened the network plugin to refuse signing arbitrary
`print` sub-key commands** via the generic send_message API. The plugin
embeds the signing cert but only USES it for the dedicated
`bambu_network_start_print` workflow — runtime control commands are blocked
client-side regardless of caller.

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
