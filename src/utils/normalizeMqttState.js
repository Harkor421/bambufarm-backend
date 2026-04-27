/**
 * Normalize a raw Bambu MQTT state into the shape the iOS app consumes.
 *
 * Used by both the REST endpoint (`/api/printer/mqtt-state`) and the WebSocket
 * push path (`broadcastMqttState` in wsManager) so both surfaces return the
 * same data shape — the app's reducer doesn't have to care whether the update
 * came from a poll or a push.
 */

function extractAms(state) {
  try {
    const units = [];
    const rawAms = state?.ams?.ams;
    if (Array.isArray(rawAms)) {
      for (const unit of rawAms) {
        units.push({
          id: unit.id ?? null,
          humidity: unit.humidity != null ? Number(unit.humidity) : null,
          temp: unit.temp != null ? Number(unit.temp) : null,
          trays: Array.isArray(unit.tray) ? unit.tray.map((t) => ({
            id: t.id ?? null,
            type: t.tray_type || null,
            color: t.tray_color || null,
            subBrand: t.tray_sub_brands || null,
            weight: t.tray_weight != null ? Number(t.tray_weight) : null,
            diameter: t.tray_diameter != null ? Number(t.tray_diameter) : null,
            remain: t.remain != null ? Number(t.remain) : null,
            nozzleMin: t.nozzle_temp_min != null ? Number(t.nozzle_temp_min) : null,
            nozzleMax: t.nozzle_temp_max != null ? Number(t.nozzle_temp_max) : null,
          })) : [],
        });
      }
    }
    const vt = state?.vt_tray;
    const virtualTray = vt && (vt.tray_type || vt.tray_color) ? {
      type: vt.tray_type || null,
      color: vt.tray_color || null,
      subBrand: vt.tray_sub_brands || null,
      weight: vt.tray_weight != null ? Number(vt.tray_weight) : null,
    } : null;
    if (units.length === 0 && !virtualTray) return null;
    return {
      units,
      virtualTray,
      trayNow: state?.ams?.tray_now ?? null,
      trayPre: state?.ams?.tray_pre ?? null,
      trayTar: state?.ams?.tray_tar ?? null,
    };
  } catch {
    return null;
  }
}

function normalizeMqttState(state) {
  if (!state) return null;
  return {
    gcodeState: state.gcode_state || null,
    percent: state.mc_percent ?? null,
    remainingMin: state.mc_remaining_time ?? null,
    layerNum: state.layer_num ?? null,
    totalLayers: state.total_layer_num ?? null,
    subtaskName: state.subtask_name || null,
    nozzleTemp: state.nozzle_temper ?? null,
    nozzleTarget: state.nozzle_target_temper ?? null,
    bedTemp: state.bed_temper ?? null,
    bedTarget: state.bed_target_temper ?? null,
    chamberTemp: state.chamber_temper ?? null,
    speedLevel: state.spd_lvl ?? null,
    speedMag: state.spd_mag ?? null,
    wifiSignal: state.wifi_signal || null,
    lightOn: state.lights_report?.[0]?.mode === "on" ?? null,
    printType: state.print_type || null,
    taskId: state.task_id || null,
    printError: state.print_error || 0,
    hms: Array.isArray(state.hms) && state.hms.length > 0 ? state.hms : null,
    preparePercent: state.gcode_file_prepare_percent != null ? Number(state.gcode_file_prepare_percent) : null,
    stage: state.stg_cur ?? null,
    ams: extractAms(state),
  };
}

module.exports = { normalizeMqttState, extractAms };
