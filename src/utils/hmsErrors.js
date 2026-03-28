/**
 * Bambu Lab HMS Error Code Database
 * Source: https://github.com/suchmememanyskill/bambu-error-codes
 *
 * HMS codes from MQTT come as { attr, code } where:
 *   attr = 0xAABBCCDD → lookup key prefix = AABB
 *   code = 0xEEFFGGHH → lookup key suffix = GGHH
 *   Combined lookup: "AABB_GGHH"
 */

// Full HMS codes from Bambu wiki (attr-attr-code-code format → looked up by "AAAABBBB_CCCCDDDD")
const HMS_FULL = {
  "07002000_00020001": "AMS filament has run out.",
  "07002000_00030001": "AMS filament has run out. Purging old filament.",
  "07002000_00020004": "AMS filament may be broken in the toolhead.",
  "07005500_00010004": "AMS binding error with the extruder. Perform AMS initialization again.",
  "07005600_00030001": "AMS failed to send filament. Check PTFE tubes.",
  "07007000_00020001": "Failed to pull filament from the toolhead to AMS.",
  "07007000_00020004": "Failed to pull back filament. Check if filament or spool is stuck.",
  "07008000_00010004": "AMS sensor abnormal. Check AMS connection.",
  "07009000_00010004": "AMS exhaust valve sensor abnormal. Contact support.",
  "07009700_00030001": "AMS filament has run out. Purging old filament.",
  "07005600_00020001": "AMS filament has run out.",
};

const HMS_CODES = {
  "0300_4000": "Printing stopped because homing Z axis failed.",
  "0300_4001": "Printer timed out waiting for nozzle to cool down before homing.",
  "0300_4002": "Printing stopped because Auto Bed Leveling failed.",
  "0300_4003": "Nozzle temperature malfunction.",
  "0300_4004": "Heatbed temperature malfunction.",
  "0300_4005": "The nozzle fan speed is abnormal.",
  "0300_4006": "The nozzle is clogged.",
  "0300_4008": "The AMS failed to change filament.",
  "0300_4009": "Homing XY axis failed.",
  "0300_400A": "Mechanical resonance frequency identification failed.",
  "0300_400B": "Internal communication exception.",
  "0300_400C": "Printing was cancelled.",
  "0300_400D": "Resume failed after power loss.",
  "0300_400E": "The motor self-check failed.",
  "0300_400F": "No build plate is placed.",
  "0300_8000": "Printing was paused for unknown reason.",
  "0300_8001": "Printing was paused by the user.",
  "0300_8002": "First layer defects detected by Micro Lidar.",
  "0300_8003": "Spaghetti defects detected by AI Print Monitoring.",
  "0300_8004": "Filament ran out. Please load new filament.",
  "0300_8005": "Toolhead front cover fell off. Please remount the front cover.",
  "0300_8006": "Build plate marker was not detected.",
  "0300_8007": "Unfinished print job after power loss.",
  "0300_8008": "Nozzle temperature problem.",
  "0300_8009": "Heatbed temperature malfunction.",
  "0300_800A": "Filament pile-up detected by AI Print Monitoring.",
  "0300_800B": "The cutter is stuck.",
  "0300_800C": "Skipping step detected, auto-recover complete.",
  "0300_800D": "Objects fell down or extruder not extruding normally.",
  "0300_800E": "Print file not available. Check storage media.",
  "0300_800F": "Door seems to be open, printing was paused.",
  "0300_8010": "Hotend fan speed is abnormal.",
  "0300_8011": "Build plate mismatch with G-code file.",
  "0300_8013": "Printing was paused by the user.",
  "0300_8014": "Nozzle covered with filaments or build plate installed incorrectly.",
  "0300_8015": "Filament has run out. Please load new filament.",
  "0300_8016": "Nozzle is clogged with filaments.",
  "0300_8017": "Foreign objects detected on hotbed.",
  "0300_8018": "Chamber temperature malfunction.",
  "0300_8019": "No build plate is placed.",
  "0500_4001": "Failed to connect to Bambu Cloud. Check network connection.",
  "0500_4002": "Unsupported print file path or name.",
  "0500_4003": "Printer unable to parse the file.",
  "0500_4004": "Can't receive new print jobs while printing.",
  "0500_4005": "Can't send print jobs while updating firmware.",
  "0500_4006": "Not enough free storage space.",
  "0500_4007": "Print jobs blocked during force update.",
  "0500_4012": "Door seems to be open, printing was paused.",
  "0500_4014": "Slicing for the print job failed.",
  "0500_4015": "Not enough free storage space on MicroSD card.",
  "0500_400B": "Problem downloading file. Check network connection.",
  "0500_400C": "Please insert a MicroSD card.",
  "0500_400D": "Run self-test and restart printing job.",
  "0500_400E": "Printing was cancelled.",
  "0500_402E": "MicroSD card file system not supported. Format to FAT32.",
  "0500_402F": "MicroSD card data is damaged.",
  "0700_4001": "AMS disabled but filament still loaded. Unload AMS filament.",
  "0700_8001": "Failed to cut the filament. Check the cutter.",
  "0700_8002": "The cutter is stuck. Pull out the cutter handle.",
  "0700_8003": "Failed to pull filament from extruder. Possible clog or broken filament.",
  "0700_8004": "AMS failed to pull back filament. Spool or filament may be stuck.",
  "0700_8005": "AMS failed to send filament. Check PTFE tubes for wear.",
  "0700_8006": "Unable to feed filament into extruder. Entangled filament or stuck spool.",
  "0700_8007": "Extruding filament failed. Extruder might be clogged.",
  "0700_8010": "AMS assist motor is overloaded. Entangled filament or stuck spool.",
  "0700_8011": "AMS filament ran out. Insert new filament.",
  "0700_8012": "Failed to get AMS mapping table.",
  "0700_8013": "Timeout purging old filament. Check for stuck filament or clogged extruder.",
  "0C00_8001": "First layer defects detected.",
  "0C00_8002": "Spaghetti failure detected.",
  "0C00_8005": "Purged filament piled up in waste chute.",
  "0C00_8009": "Build plate localization marker not found.",
  "0C00_800A": "Build plate mismatch with G-code.",
  "0C00_C003": "Possible first layer defects detected.",
  "0C00_C004": "Possible spaghetti failure detected.",
  "0C00_C006": "Purged filament may have piled up in waste chute.",
  "1000_C001": "High bed temperature may cause filament clogging. Open chamber door.",
  "1000_C003": "Traditional timelapse might cause defects.",
  "1200_8001": "Failed to cut filament. Check the cutter.",
  "1200_8002": "The cutter is stuck.",
  "1200_8003": "Failed to pull filament from extruder.",
  "1200_8004": "Failed to pull back filament from toolhead.",
  "1200_8006": "Unable to feed filament into extruder.",
  "1200_8007": "Failed to extrude filament. Possible clog.",
  "1200_8010": "Filament or spool may be stuck.",
  "1200_8011": "AMS filament ran out.",
  "1200_8013": "Timeout purging old filament.",
  "1200_8014": "Filament location in toolhead not found.",
  "1200_8015": "Failed to pull filament from toolhead.",
  "1200_8016": "Extruder not extruding normally.",
};

/**
 * Look up an HMS error description from the MQTT attr/code pair.
 * @param {number} attr - HMS attr field (e.g., 117479168 = 0x07009700)
 * @param {number} code - HMS code field (e.g., 196609 = 0x00030001)
 * @returns {string|null} Human-readable description or null
 */
function lookupHmsError(attr, code) {
  const attrHex = (attr >>> 0).toString(16).padStart(8, "0");
  const codeHex = (code >>> 0).toString(16).padStart(8, "0");

  // Try exact full match first (most accurate)
  const fullKey = `${attrHex}_${codeHex}`.toUpperCase();
  if (HMS_FULL[fullKey.toLowerCase()]) return HMS_FULL[fullKey.toLowerCase()];
  if (HMS_FULL[fullKey]) return HMS_FULL[fullKey];

  // The database key format is: MMDD_SSEE where
  //   MM = module (attr bytes 0-1), DD = device/sub (attr bytes 2-3)
  //   SS = severity (attr byte 4-5), EE = error id (code last byte(s))
  // Try multiple combinations to find a match
  const keys = [
    // Most common: module(4) + "_" + submodule(2) + errorId(2)
    `${attrHex.slice(0, 4)}_${attrHex.slice(4, 6)}${codeHex.slice(6, 8)}`,
    // Module(4) + "_" + full code suffix
    `${attrHex.slice(0, 4)}_${codeHex.slice(4, 8)}`,
    // Module(2)+"00" + "_" + submodule(2) + errorId(2)
    `${attrHex.slice(0, 2)}00_${attrHex.slice(4, 6)}${codeHex.slice(6, 8)}`,
    // Module(2) + "FF" + "_" + submodule(2) + errorId(2)
    `${attrHex.slice(0, 2)}FF_${attrHex.slice(4, 6)}${codeHex.slice(6, 8)}`,
    // Just module + error byte
    `${attrHex.slice(0, 4)}_${codeHex.slice(0, 4)}`,
  ];

  for (const key of keys) {
    const upper = key.toUpperCase();
    const lower = key.toLowerCase();
    if (HMS_CODES[upper]) return HMS_CODES[upper];
    if (HMS_CODES[lower]) return HMS_CODES[lower];
  }

  // Fallback: try replacing AMS slot-specific sub-modules with generic ones
  // AMS slots use different sub-module IDs (20xx, 56xx, 97xx, etc.) but share the same errors
  // Try matching with 00, 01, 02, 03, FF as the module suffix
  const module = attrHex.slice(0, 2);
  const errorByte = codeHex.slice(6, 8);
  const suffixes = ["00", "01", "02", "03", "FF"];
  for (const sfx of suffixes) {
    const subModule = attrHex.slice(4, 6);
    const tryKey = `${module}${sfx}_${subModule}${errorByte}`;
    if (HMS_CODES[tryKey.toUpperCase()]) return HMS_CODES[tryKey.toUpperCase()];
    if (HMS_CODES[tryKey]) return HMS_CODES[tryKey];
  }

  // Try with common sub-modules for AMS (0700 module)
  if (module === "07") {
    const errSuffix = codeHex.slice(6, 8);
    for (const prefix of ["0700", "0701", "0702", "0703", "07FF", "0300", "1200"]) {
      const subMod = attrHex.slice(4, 6);
      const tryKeys = [
        `${prefix}_${subMod}${errSuffix}`,
        `${prefix}_80${errSuffix}`,
      ];
      for (const tk of tryKeys) {
        if (HMS_CODES[tk.toUpperCase()]) return HMS_CODES[tk.toUpperCase()];
        if (HMS_CODES[tk]) return HMS_CODES[tk];
      }
    }
  }

  return null;
}

/**
 * Format an HMS code for display.
 * @param {number} attr
 * @param {number} code
 * @returns {string} e.g., "0700-9700-0003-0001"
 */
function formatHmsCode(attr, code) {
  const attrHex = (attr >>> 0).toString(16).padStart(8, "0").toUpperCase();
  const codeHex = (code >>> 0).toString(16).padStart(8, "0").toUpperCase();
  return `${attrHex.slice(0, 4)}-${attrHex.slice(4, 8)}-${codeHex.slice(0, 4)}-${codeHex.slice(4, 8)}`;
}


module.exports = { lookupHmsError, formatHmsCode };
