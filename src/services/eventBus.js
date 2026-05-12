/**
 * Shared event bus for decoupling services.
 * Eliminates circular dependencies between mqttPrinterService and wsManager.
 *
 * To add a new event:
 *   1. Add a key to EVENTS below (so the name lives in one place)
 *   2. Document the payload shape next to it
 *   3. Import { EVENTS } anywhere you need to emit/listen
 *
 * Catching typos at the constant level is the whole point — a misspelled
 * event name in a bare string would silently no-op.
 */

const { EventEmitter } = require("events");

const eventBus = new EventEmitter();
eventBus.setMaxListeners(20);

/**
 * Canonical event names. Keep payload contracts in the JSDoc.
 */
const EVENTS = {
  /**
   * Emitted by mqttPrinterService when a printer's gcode_state changes.
   * Payload: { bambuUid: string, devId: string, state: object, prev: string|undefined }
   */
  PRINTER_STATE_CHANGE: "printer:stateChange",
};

module.exports = eventBus;
module.exports.EVENTS = EVENTS;
