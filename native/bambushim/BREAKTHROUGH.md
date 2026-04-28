# BREAKTHROUGH FINDING — Bambu plugin works on Linux

## The Mac wall ≠ Linux wall

After exhaustive testing on macOS (this whole session), confirmed via the
**dafik/OrcaSlicer-bambulab** fork (mirror of the deleted jarczakpawel
repo before Bambu's C&D wiped it):

**The plugin's `-2` rejection on `print` commands is Mac-only.**

The Mac plugin verifies the calling process's code signature via
`SecCodeCheckValidity` requiring the leaf certificate's OU to be
`T3UBR9Y3B2` (Bambu Lab Limited's Apple Developer team ID).

On **Linux** the plugin has no equivalent check — `dlopen()` and call.

## How jarczak's solution works (for Mac users)

1. Build `pjarczak_bambu_linux_host` — a Linux binary that:
   ```cpp
   m_network = dlopen("libbambu_networking.so", RTLD_LAZY);
   // forward JSON-RPC requests to plugin functions
   ```

2. On Mac, patch OrcaSlicer to load a shim library instead of the real
   plugin. The shim spawns the Linux host as a subprocess via
   `boost::process` and proxies all plugin calls over stdin/stdout JSON
   frames (`tools/pjarczak_bambu_macos_linux_wrapper` runs the Linux
   binary on Mac somehow — TBD if qemu/Docker/static).

3. The Linux subprocess does the actual signing because Linux plugin
   doesn't enforce caller-process verification.

## Implication for BambuFarm

**Our Railway backend is Linux x86_64.** We never tested there because we
spent this whole session on Mac chasing the SecCodeCheckValidity wall.

Realistic expectation: deploy our existing shim + the Linux
libbambu_networking.so to Railway and `send_message` for `print` commands
should just work — no proxy/subprocess needed because we're already on
Linux.

## Reference

- Mirror of the deleted solution: https://github.com/dafik/OrcaSlicer-bambulab
- Original (wiped after Bambu C&D): https://github.com/jarczakpawel/OrcaSlicer-bambulab
- Tom's Hardware article on the takedown: search "OrcaSlicer-bambulab Bambu Lab security update"
