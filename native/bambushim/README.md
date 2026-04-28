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

## Known Blocker (last 5%)

`send_message(devId, jsonString, qos, flag)` returns `-2` on every call,
even after subscribing and waiting for confirmation. Possible causes (all
unverified — plugin logs are encrypted):

1. **Subscription ack not received**: `OnSubscribeFailureFn` should fire if
   subscribe failed; we wired it but never saw it. Maybe needs more time or
   a different module name.
2. **Device not in user's "owned" list**: plugin may fetch the printer list
   on login and only allow commands to printers in that list. Our test user
   does own the printer though.
3. **Wrong ABI version**: BBLNetworkPlugin in OrcaSlicer detects "legacy" vs
   new ABI and the legacy `send_message` takes 4 args (no `flag`). Our
   plugin may need 4-arg variant — though calling with 5 args shouldn't
   crash (extra arg just ignored on stack).
4. **Need `connect_printer` first**: even for cloud, OrcaSlicer's
   `BBLPrinterAgent` calls connect_printer before send_message. We tried
   without that.
5. **Country code mismatch**: plugin may route to wrong region (CN vs US
   broker) based on `set_country_code`.

## Next steps to crack -2

- Wire `OnSubscribeFailureFn` callback to see if subscribe fails async
- Try `connect_printer(dev_id, "", "", "", false)` before send (cloud path)
- Try with country code matching the user's actual region
- Compare with strace/dtruss output to see what the plugin is doing
- Try with `send_message_to_printer` (LAN path) to isolate cloud vs LAN

## Legal

The Bambu plugin binary is © Bambu Lab. Their EULA prohibits redistribution
and reverse-engineering. This integration is for our own backend use only;
the binaries are not bundled in client-distributed builds and not committed
to git (see `.gitignore`).
