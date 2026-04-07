const config = require("../config");

describe("config", () => {
  it("has all required sections", () => {
    expect(config.bambu).toBeDefined();
    expect(config.mqtt).toBeDefined();
    expect(config.apns).toBeDefined();
    expect(config.vision).toBeDefined();
    expect(config.tecnoprints).toBeDefined();
    expect(config.ws).toBeDefined();
  });

  it("has correct Bambu API defaults", () => {
    expect(config.bambu.apiBase).toBe("https://api.bambulab.com");
    expect(config.bambu.mqttHost).toBe("us.mqtt.bambulab.com");
    expect(config.bambu.mqttPort).toBe(8883);
  });

  it("has correct APNS defaults", () => {
    expect(config.apns.bundleId).toBe("com.harkor421.bambufarm");
    expect(config.apns.hostSandbox).toBe("api.sandbox.push.apple.com");
  });

  it("has correct vision defaults", () => {
    expect(config.vision.model).toBe("claude-haiku-4-5-20251001");
    expect(config.vision.percentStep).toBe(5);
    expect(config.vision.minLayer).toBe(5);
    expect(config.vision.confidenceThreshold).toBe(40);
    expect(config.vision.consecutiveFailures).toBe(2);
  });

  it("has correct MQTT defaults", () => {
    expect(config.mqtt.staggerPauseEvery).toBe(10);
    expect(config.mqtt.rateLimitBackoff).toBe(10000);
    expect(config.mqtt.progressThrottle).toBe(150000);
  });

  it("has correct WS defaults", () => {
    expect(config.ws.heartbeatInterval).toBe(30000);
    expect(config.ws.frameThrottle).toBe(2000);
    expect(config.ws.commandTimeout).toBe(10000);
    expect(config.ws.authTimeout).toBe(15000);
  });

  it("port defaults to 3000", () => {
    expect(config.port).toBe(Number(process.env.PORT) || 3000);
  });

  it("tecnoprints has dedup window", () => {
    expect(config.tecnoprints.dedupWindow).toBe(30000);
  });
});
