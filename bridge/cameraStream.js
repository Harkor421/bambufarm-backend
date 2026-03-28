/**
 * Camera TLS stream client for BambuLab printers.
 * Ported from src/services/bambuCamera.js (React Native) to Node.js native TLS.
 *
 * Protocol:
 *   1. Connect TLS to printer:6000 (self-signed cert, skip verification)
 *   2. Send 80-byte auth packet
 *   3. Receive frames: 16-byte header (LE uint32 payload size at offset 0) + JPEG payload
 */

const tls = require("tls");

const CAMERA_PORT = 6000;
const HEADER_SIZE = 16;
const AUTH_TIMEOUT_MS = 5000;
const MAX_PAYLOAD = 5 * 1024 * 1024; // 5MB sanity limit

/**
 * Build the 80-byte auth packet.
 * Bytes 0-3:   0x40 (LE uint32)
 * Bytes 4-7:   0x3000 (LE uint32)
 * Bytes 8-15:  zeros
 * Bytes 16-47: "bblp" null-padded to 32 bytes
 * Bytes 48-79: accessCode null-padded to 32 bytes
 */
function buildAuthPacket(accessCode) {
  const buf = Buffer.alloc(80, 0);
  buf.writeUInt32LE(0x40, 0);
  buf.writeUInt32LE(0x3000, 4);
  buf.write("bblp", 16, "ascii");
  buf.write(accessCode, 48, "ascii");
  return buf;
}

/**
 * Connect to a printer camera and stream JPEG frames.
 *
 * @param {Object} opts
 * @param {string} opts.ip - Printer LAN IP
 * @param {string} opts.accessCode - Printer access code
 * @param {(jpeg: Buffer) => void} opts.onFrame - Raw JPEG buffer callback
 * @param {(state: string, msg?: string) => void} opts.onStateChange
 * @returns {{ stop: () => void }}
 */
function createCameraStream({ ip, accessCode, onFrame, onStateChange }) {
  let socket = null;
  let stopped = false;
  let buffer = Buffer.alloc(0);
  let payloadSize = null;
  let authTimer = null;
  let gotFirstFrame = false;

  function emit(state, message) {
    if (!stopped) onStateChange(state, message);
  }

  function cleanup() {
    stopped = true;
    if (authTimer) clearTimeout(authTimer);
    authTimer = null;
    if (socket) {
      try { socket.destroy(); } catch {}
    }
    socket = null;
    buffer = Buffer.alloc(0);
    payloadSize = null;
  }

  function processBuffer() {
    while (true) {
      if (payloadSize === null) {
        if (buffer.length < HEADER_SIZE) break;
        payloadSize = buffer.readUInt32LE(0);
        buffer = buffer.slice(HEADER_SIZE);

        if (payloadSize <= 0 || payloadSize > MAX_PAYLOAD) {
          emit("error", "Invalid frame header — check access code");
          cleanup();
          return;
        }
      }

      if (payloadSize !== null) {
        if (buffer.length < payloadSize) break;

        const jpeg = buffer.slice(0, payloadSize);
        buffer = buffer.slice(payloadSize);
        payloadSize = null;

        // Validate JPEG magic bytes
        if (jpeg.length >= 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8) {
          if (!gotFirstFrame) {
            gotFirstFrame = true;
            if (authTimer) clearTimeout(authTimer);
            authTimer = null;
            emit("connected");
          }
          if (!stopped) onFrame(jpeg);
        }
      }
    }
  }

  try {
    emit("connecting");

    socket = tls.connect(
      {
        host: ip,
        port: CAMERA_PORT,
        rejectUnauthorized: false,
      },
      () => {
        if (stopped) return;
        socket.write(buildAuthPacket(accessCode));

        authTimer = setTimeout(() => {
          if (!gotFirstFrame && !stopped) {
            emit("authFailed", "No response — check access code");
            cleanup();
          }
        }, AUTH_TIMEOUT_MS);
      }
    );

    socket.on("data", (data) => {
      if (stopped) return;
      buffer = Buffer.concat([buffer, data]);
      processBuffer();
    });

    socket.on("error", (err) => {
      if (stopped) return;
      emit("error", err.message || "Connection error");
      cleanup();
    });

    socket.on("close", () => {
      if (stopped) return;
      if (!gotFirstFrame) {
        emit("error", "Connection closed before receiving frames");
      } else {
        emit("disconnected");
      }
      cleanup();
    });
  } catch (err) {
    emit("error", err.message || "Failed to connect");
    cleanup();
  }

  return {
    stop() {
      if (!stopped) {
        emit("disconnected");
        cleanup();
      }
    },
  };
}

module.exports = { createCameraStream };
