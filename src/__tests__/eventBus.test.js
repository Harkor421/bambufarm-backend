const eventBus = require("../services/eventBus");
const { EVENTS } = require("../services/eventBus");

describe("eventBus", () => {
  it("is an EventEmitter", () => {
    expect(typeof eventBus.on).toBe("function");
    expect(typeof eventBus.emit).toBe("function");
    expect(typeof eventBus.removeListener).toBe("function");
  });

  it("exports the canonical event-name constants", () => {
    expect(EVENTS.PRINTER_STATE_CHANGE).toBe("printer:stateChange");
  });

  it("emits and receives printer:stateChange events", (done) => {
    const handler = (data) => {
      expect(data.bambuUid).toBe("123");
      expect(data.devId).toBe("PRINTER1");
      eventBus.removeListener(EVENTS.PRINTER_STATE_CHANGE, handler);
      done();
    };
    eventBus.on(EVENTS.PRINTER_STATE_CHANGE, handler);
    eventBus.emit(EVENTS.PRINTER_STATE_CHANGE, {
      bambuUid: "123",
      devId: "PRINTER1",
      state: {},
    });
  });

  it("supports multiple listeners", () => {
    let count = 0;
    const h1 = () => count++;
    const h2 = () => count++;
    eventBus.on("test:multi", h1);
    eventBus.on("test:multi", h2);
    eventBus.emit("test:multi");
    expect(count).toBe(2);
    eventBus.removeListener("test:multi", h1);
    eventBus.removeListener("test:multi", h2);
  });
});
