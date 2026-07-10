/**
 * RTSP(S) camera stream client for newer BambuLab printers (X1 series, H2
 * family, P2S). These models don't expose the port-6000 JPEG protocol that
 * P1/A1 printers use — they serve an RTSPS stream on port 322 instead
 * (requires "LAN Mode Liveview" enabled in the printer's network settings):
 *
 *   rtsps://bblp:<accessCode>@<ip>:322/streaming/live/1
 *
 * Decoding RTP/H.264 natively in Node isn't practical, so we spawn ffmpeg to
 * pull the stream and emit MJPEG on stdout; frames are re-split on JPEG
 * SOI/EOI markers and fed to the same onFrame pipeline the port-6000 client
 * uses, so everything downstream (ws relay, app, widgets) works unchanged.
 *
 * ffmpeg is resolved from, in order: the FFMPEG_PATH env var, the optional
 * ffmpeg-static package, or plain "ffmpeg" on the system PATH.
 */

const { spawn } = require("child_process");
const fs = require("fs");

const RTSP_PORT = 322;
const OUTPUT_FPS = 2; // match the ~P1/A1 cadence; keeps relay bandwidth sane
const FIRST_FRAME_TIMEOUT_MS = 20000; // stream must produce a frame this fast
const STALL_TIMEOUT_MS = 20000; // no frames for this long → restart
const MAX_FRAME = 5 * 1024 * 1024; // 5MB sanity limit (same as TLS client)
const STDERR_KEEP = 4096; // rolling tail of ffmpeg stderr for diagnostics

// Well-known ffmpeg install locations. A packaged (GUI) Electron app on macOS
// does NOT inherit the user's shell PATH — launchd gives it only
// /usr/bin:/bin:/usr/sbin:/sbin — so a Homebrew ffmpeg would never be found
// via a bare "ffmpeg" spawn. Probe the usual absolute paths explicitly.
const KNOWN_FFMPEG_PATHS = [
  "/opt/homebrew/bin/ffmpeg", // macOS brew (Apple Silicon)
  "/usr/local/bin/ffmpeg", // macOS brew (Intel) / manual installs
  "/usr/bin/ffmpeg", // Linux distro packages
];

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    // Optional dependency — present in dev; excluded from packaged builds
    // (it only ships the build machine's arch).
    const p = require("ffmpeg-static");
    if (p && fs.existsSync(p)) return p;
  } catch {}
  for (const p of KNOWN_FFMPEG_PATHS) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return "ffmpeg"; // last resort: hope it's on PATH
}

/**
 * Connect to a printer's RTSPS camera and stream JPEG frames.
 * Same interface as cameraStream.createCameraStream.
 *
 * @param {Object} opts
 * @param {string} opts.ip - Printer LAN IP
 * @param {string} opts.accessCode - Printer access code
 * @param {(jpeg: Buffer) => void} opts.onFrame - Raw JPEG buffer callback
 * @param {(state: string, msg?: string) => void} opts.onStateChange
 * @returns {{ stop: () => void }}
 */
function createRtspCameraStream({ ip, accessCode, onFrame, onStateChange }) {
  let proc = null;
  let stopped = false;
  let buffer = Buffer.alloc(0);
  let stderrTail = "";
  let watchdog = null;
  let gotFirstFrame = false;
  // When the resolved ffmpeg fails to launch (e.g. a bundled ffmpeg-static
  // built for the wrong CPU arch inside a cross-built app), retry ONCE with
  // plain "ffmpeg" from the system PATH before giving up.
  let ffmpegOverride = null;
  let triedSystemFallback = false;

  function emit(state, message) {
    if (!stopped) onStateChange(state, message);
  }

  function cleanup() {
    stopped = true;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    if (proc) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
    proc = null;
    buffer = Buffer.alloc(0);
  }

  function armWatchdog(ms, why) {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      emit("error", why);
      cleanup();
    }, ms);
  }

  // MJPEG from image2pipe is concatenated JPEGs — split on SOI (FFD8FF) /
  // EOI (FFD9) markers.
  function processBuffer() {
    while (true) {
      const start = buffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
      if (start === -1) {
        // No frame start in sight — drop garbage to stay bounded.
        if (buffer.length > MAX_FRAME) buffer = Buffer.alloc(0);
        return;
      }
      if (start > 0) buffer = buffer.slice(start);

      const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end === -1) {
        if (buffer.length > MAX_FRAME) {
          emit("error", "Oversized frame from ffmpeg — resetting");
          buffer = Buffer.alloc(0);
        }
        return;
      }

      const frame = buffer.slice(0, end + 2);
      buffer = buffer.slice(end + 2);

      if (!gotFirstFrame) {
        gotFirstFrame = true;
        emit("streaming");
      }
      armWatchdog(STALL_TIMEOUT_MS, "Stream stalled — no frames for 20s");
      try {
        onFrame(frame);
      } catch {}
    }
  }

  function classifyExit(code) {
    const tail = stderrTail.toLowerCase();
    if (tail.includes("401") || tail.includes("unauthorized")) {
      return ["authFailed", "RTSP auth rejected — check access code"];
    }
    if (tail.includes("connection refused")) {
      return [
        "error",
        "RTSP port closed — enable 'LAN Mode Liveview' in the printer's network settings",
      ];
    }
    if (tail.includes("no such file") || tail.includes("enoent")) {
      return ["error", "ffmpeg not found — install it (brew install ffmpeg) or set FFMPEG_PATH"];
    }
    return ["disconnected", `ffmpeg exited (code ${code})`];
  }

  function start() {
    const ffmpeg = ffmpegOverride || resolveFfmpegPath();
    const url = `rtsps://bblp:${encodeURIComponent(accessCode)}@${ip}:${RTSP_PORT}/streaming/live/1`;

    emit("connecting");
    armWatchdog(FIRST_FRAME_TIMEOUT_MS, "No video within 20s — is 'LAN Mode Liveview' enabled?");

    // -rtsp_transport tcp: Bambu's rtsps is TLS/TCP; UDP won't work.
    // image2pipe + mjpeg: emit whole JPEGs on stdout for the marker splitter.
    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      "-rtsp_transport", "tcp",
      "-i", url,
      "-an",
      "-vf", `fps=${OUTPUT_FPS}`,
      "-c:v", "mjpeg",
      "-q:v", "6",
      "-f", "image2pipe",
      "-",
    ];

    let p;
    try {
      p = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      emit("error", `Failed to launch ffmpeg: ${err.message}`);
      cleanup();
      return;
    }
    proc = p;

    p.stdout.on("data", (chunk) => {
      if (stopped || p !== proc) return;
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer();
    });

    p.stderr.on("data", (chunk) => {
      if (p !== proc) return;
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_KEEP);
    });

    p.on("error", (err) => {
      // Events from a superseded process (after the fallback respawn) must
      // not touch the live stream.
      if (p !== proc || stopped) return;
      // ENOENT (binary missing) and ENOEXEC/EACCES (wrong-arch or unusable
      // bundled binary) land here, not in classifyExit. If we weren't already
      // using plain "ffmpeg", fall back to the system one once.
      if (ffmpeg !== "ffmpeg" && !triedSystemFallback) {
        triedSystemFallback = true;
        ffmpegOverride = "ffmpeg";
        try { p.kill("SIGKILL"); } catch {}
        proc = null;
        start();
        return;
      }
      if (err.code === "ENOENT") {
        emit("error", "ffmpeg not found — install it (brew install ffmpeg) or set FFMPEG_PATH");
      } else {
        emit("error", `ffmpeg error: ${err.message}`);
      }
      cleanup();
    });

    p.on("exit", (code) => {
      if (p !== proc || stopped) return;
      const [state, msg] = classifyExit(code);
      emit(state, msg);
      cleanup();
    });
  }

  start();

  return {
    stop() {
      cleanup();
    },
  };
}

module.exports = { createRtspCameraStream, resolveFfmpegPath, RTSP_PORT };
