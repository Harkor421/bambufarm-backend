/**
 * Shared event bus for decoupling services.
 * Eliminates circular dependencies between mqttPrinterService and wsManager.
 *
 * Events:
 *   'printer:stateChange' { bambuUid, devId, state } — emitted by MQTT on gcode_state change
 */

const { EventEmitter } = require("events");

const eventBus = new EventEmitter();
eventBus.setMaxListeners(20);

module.exports = eventBus;
