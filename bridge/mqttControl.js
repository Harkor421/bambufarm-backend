/**
 * Local MQTT control for Bambu printers.
 * Connects to printers on LAN via MQTT (port 8883, TLS)
 * and sends control commands (pause, resume, stop, speed, light, gcode).
 *
 * No signing required — local MQTT accepts commands with bblp auth.
 */

const mqtt = require("mqtt");

const MQTT_PORT = 8883;

class PrinterMqttControl {
  constructor() {
    this.clients = new Map(); // devId → { client, connected, sequenceId }
  }

  /**
   * Connect to a printer's local MQTT broker.
   * @param {string} devId - Device ID
   * @param {string} ip - Printer LAN IP
   * @param {string} accessCode - Printer access code
   */
  connect(devId, ip, accessCode) {
    if (this.clients.has(devId)) return;

    const client = mqtt.connect(`mqtts://${ip}:${MQTT_PORT}`, {
      username: "bblp",
      password: accessCode,
      clientId: `bridge_ctrl_${devId}_${Date.now()}`,
      rejectUnauthorized: false,
      connectTimeout: 5000,
      reconnectPeriod: 10000,
    });

    const entry = { client, connected: false, sequenceId: 0 };
    this.clients.set(devId, entry);

    client.on("connect", () => {
      entry.connected = true;
      console.log(`[MQTT-Ctrl] Connected to ${devId} (${ip})`);
      // Subscribe to report topic to see command responses
      client.subscribe(`device/${devId}/report`, { qos: 1 });
    });

    client.on("message", (topic, payload) => {
      try {
        const json = JSON.parse(payload.toString());
        // Log state changes and security responses
        if (json.print?.gcode_state) {
          console.log(`[MQTT-Ctrl] ${devId} state: ${json.print.gcode_state}`);
        }
        if (json.security) {
          console.log(`[MQTT-Ctrl] ${devId} security:`, JSON.stringify(json.security));
        }
      } catch {}
    });

    client.on("close", () => {
      entry.connected = false;
    });

    client.on("error", (err) => {
      console.error(`[MQTT-Ctrl] Error ${devId}: ${err.message}`);
    });
  }

  /**
   * Disconnect from a printer.
   */
  disconnect(devId) {
    const entry = this.clients.get(devId);
    if (!entry) return;
    try { entry.client.end(true); } catch {}
    this.clients.delete(devId);
  }

  /**
   * Disconnect all printers.
   */
  disconnectAll() {
    for (const [devId] of this.clients) {
      this.disconnect(devId);
    }
  }

  /**
   * Send a raw command to a printer.
   * @param {string} devId
   * @param {object} command - MQTT command payload
   * @returns {boolean} true if sent
   */
  sendCommand(devId, command) {
    const entry = this.clients.get(devId);
    if (!entry?.connected) return false;

    const topic = `device/${devId}/request`;
    entry.sequenceId++;
    try {
      entry.client.publish(topic, JSON.stringify(command));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute a named command.
   * @param {string} devId
   * @param {string} action - "pause", "resume", "stop", "speed", "light", "gcode"
   * @param {object} params - Action-specific parameters
   * @returns {boolean}
   */
  executeCommand(devId, action, params = {}) {
    const entry = this.clients.get(devId);
    if (!entry) return false;
    const seq = String(entry.sequenceId + 1);

    switch (action) {
      case "pause":
        return this.sendCommand(devId, { print: { sequence_id: seq, command: "pause" } });
      case "resume":
        return this.sendCommand(devId, { print: { sequence_id: seq, command: "resume" } });
      case "stop":
        return this.sendCommand(devId, { print: { sequence_id: seq, command: "stop" } });
      case "speed":
        return this.sendCommand(devId, { print: { sequence_id: seq, command: "print_speed", param: String(params.level || 2) } });
      case "light":
        return this.sendCommand(devId, {
          system: {
            sequence_id: seq, command: "ledctrl",
            led_node: "chamber_light", led_mode: params.on ? "on" : "off",
            led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0,
          },
        });
      case "gcode":
        return this.sendCommand(devId, { print: { sequence_id: seq, command: "gcode_line", param: params.gcode || "" } });
      default:
        console.warn(`[MQTT-Ctrl] Unknown action: ${action}`);
        return false;
    }
  }

  /**
   * Check if a printer is connected.
   */
  isConnected(devId) {
    return this.clients.get(devId)?.connected || false;
  }
}

module.exports = { PrinterMqttControl };
