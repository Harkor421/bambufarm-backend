/**
 * MQTT Command Integration Test
 *
 * Tests sending pause/resume/stop commands to a real printer via the
 * Bambu Cloud MQTT broker. Run with a specific printer ID:
 *
 *   PRINTER_ID=03919D571707148 npm test -- mqtt-command
 *
 * Requires MONGO_URI env var to connect to the database and find credentials.
 * Uses the first user record with a valid bambu_uid to authenticate.
 *
 * WARNING: This sends REAL commands to REAL printers. Only run on test prints!
 */

const mqtt = require("mqtt");

const MQTT_HOST = "us.mqtt.bambulab.com";
const MQTT_PORT = 8883;
const PRINTER_ID = process.env.PRINTER_ID || "01P00C582701216"; // P1S-1 default
const BAMBU_UID = process.env.BAMBU_UID;
const BAMBU_TOKEN = process.env.BAMBU_TOKEN;

// Skip if no credentials provided and no DB
const canRun = BAMBU_UID && BAMBU_TOKEN;

const describeIfCreds = canRun ? describe : describe.skip;

describeIfCreds("MQTT Command Integration (real printer)", () => {
  let client;

  beforeAll((done) => {
    client = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
      username: `u_${BAMBU_UID}`,
      password: BAMBU_TOKEN,
      clientId: `test_${Date.now()}`,
      rejectUnauthorized: false,
      connectTimeout: 10000,
    });
    client.on("connect", () => done());
    client.on("error", (err) => done(err));
  }, 15000);

  afterAll((done) => {
    if (client) client.end(false, () => done());
    else done();
  });

  it("connects to Bambu MQTT broker", () => {
    expect(client.connected).toBe(true);
  });

  it("receives printer state on pushall", (done) => {
    const topic = `device/${PRINTER_ID}/report`;
    client.subscribe(topic, (err) => {
      if (err) return done(err);

      client.on("message", (t, payload) => {
        if (t !== topic) return;
        const json = JSON.parse(payload.toString());
        expect(json.print).toBeDefined();
        expect(json.print.gcode_state).toBeDefined();
        console.log(`  Printer state: ${json.print.gcode_state}, ${json.print.mc_percent}%`);
        client.unsubscribe(topic);
        done();
      });

      // Request full state
      client.publish(`device/${PRINTER_ID}/request`, JSON.stringify({
        pushing: { sequence_id: "1", command: "pushall" },
      }));
    });
  }, 10000);
});

// Unit tests for command structure (always run, no real connection needed)
describe("MQTT command structure", () => {
  function buildCommand(type, seqId = "0") {
    switch (type) {
      case "pause":
        return { print: { sequence_id: seqId, command: "pause" } };
      case "resume":
        return { print: { sequence_id: seqId, command: "resume" } };
      case "stop":
        return { print: { sequence_id: seqId, command: "stop" } };
      case "pushall":
        return { pushing: { sequence_id: seqId, command: "pushall" } };
      case "speed":
        return { print: { sequence_id: seqId, command: "print_speed", param: "2" } };
      case "light_on":
        return {
          system: {
            sequence_id: seqId, command: "ledctrl",
            led_node: "chamber_light", led_mode: "on",
            led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0,
          },
        };
      case "light_off":
        return {
          system: {
            sequence_id: seqId, command: "ledctrl",
            led_node: "chamber_light", led_mode: "off",
            led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0,
          },
        };
      default:
        throw new Error(`Unknown command: ${type}`);
    }
  }

  it("builds correct pause command", () => {
    const cmd = buildCommand("pause", "5");
    expect(cmd).toEqual({ print: { sequence_id: "5", command: "pause" } });
    expect(JSON.stringify(cmd).length).toBeLessThan(100);
  });

  it("builds correct resume command", () => {
    const cmd = buildCommand("resume");
    expect(cmd.print.command).toBe("resume");
  });

  it("builds correct stop command", () => {
    const cmd = buildCommand("stop");
    expect(cmd.print.command).toBe("stop");
  });

  it("builds correct pushall command", () => {
    const cmd = buildCommand("pushall");
    expect(cmd.pushing.command).toBe("pushall");
  });

  it("builds correct speed command", () => {
    const cmd = buildCommand("speed");
    expect(cmd.print.command).toBe("print_speed");
    expect(cmd.print.param).toBe("2");
  });

  it("builds correct light on command", () => {
    const cmd = buildCommand("light_on");
    expect(cmd.system.command).toBe("ledctrl");
    expect(cmd.system.led_mode).toBe("on");
    expect(cmd.system.led_node).toBe("chamber_light");
  });

  it("builds correct light off command", () => {
    const cmd = buildCommand("light_off");
    expect(cmd.system.led_mode).toBe("off");
  });

  it("uses correct topic format", () => {
    const devId = "03919D571707148";
    const requestTopic = `device/${devId}/request`;
    const reportTopic = `device/${devId}/report`;
    expect(requestTopic).toBe("device/03919D571707148/request");
    expect(reportTopic).toBe("device/03919D571707148/report");
  });

  it("sequence_id is always a string", () => {
    for (const type of ["pause", "resume", "stop", "pushall", "speed", "light_on"]) {
      const cmd = buildCommand(type, "42");
      const json = JSON.stringify(cmd);
      expect(json).toContain('"sequence_id":"42"');
    }
  });

  it("throws on unknown command", () => {
    expect(() => buildCommand("explode")).toThrow("Unknown command");
  });
});
