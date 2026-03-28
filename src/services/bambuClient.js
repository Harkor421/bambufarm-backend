const axios = require("axios");

const BAMBU_BASE = "https://api.bambulab.com";

// ── Helpers ported from src/api/bambu/normalizePrinters.js ──

function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return fallback;
}

function normalizeStatusFromString(s) {
  const status = String(s ?? "").toLowerCase().trim();
  // Bambu Cloud bind API returns uppercase: ACTIVE, SUCCESS, FAIL
  if (status === "active") return "printing";
  if (status === "success" || status === "fail") return "online";
  if (status.includes("print") || status.includes("running")) return "printing";
  if (status.includes("pause")) return "paused";
  if (
    status.includes("off") ||
    status.includes("disconnect") ||
    status.includes("sleep") ||
    status.includes("inactive") ||
    status.includes("fault") ||
    status.includes("lost")
  )
    return "offline";
  if (
    status.includes("idle") ||
    status.includes("ready") ||
    status.includes("online") ||
    status.includes("finish") ||
    status.includes("complete") ||
    status.includes("free")
  )
    return "online";
  return null;
}

function resolveDeviceStatus(dev) {
  const onlineFlag = pick(dev, ["online", "dev_online", "dev_online_status"], null);
  const isOnline = onlineFlag === true || onlineFlag === "true" || onlineFlag === 1;

  const s = pick(dev, ["print_status", "dev_status", "status", "state", "device_state", "dev_state"], "");
  const fromString = normalizeStatusFromString(s);

  // If device is offline, never report as printing/paused — Bambu Cloud
  // sometimes keeps stale ACTIVE status for offline printers
  if (!isOnline) {
    if (onlineFlag === false || onlineFlag === "false" || onlineFlag === 0) return "offline";
    if (fromString && fromString !== "printing" && fromString !== "paused") return fromString;
    return "offline";
  }

  if (fromString) return fromString;
  return "online";
}

// ── Bambu API calls ──

async function fetchPrinters(accessToken) {
  const r = await axios.get(`${BAMBU_BASE}/v1/iot-service/api/user/bind`, {
    timeout: 15000,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  return r.data;
}

async function fetchTasks(accessToken, limit = 5) {
  const r = await axios.get(`${BAMBU_BASE}/v1/user-service/my/tasks`, {
    timeout: 15000,
    params: { limit },
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const data = r.data?.data ?? r.data;
  return Array.isArray(data?.hits) ? data.hits : Array.isArray(data) ? data : [];
}

/**
 * Fetch printers + tasks and combine them for reliable printing detection.
 * Uses taskStatus === 4 (same logic as the app) to determine printing state.
 */
async function fetchNormalizedPrinters(accessToken) {
  const [printerData, tasks] = await Promise.all([
    fetchPrinters(accessToken),
    fetchTasks(accessToken),
  ]);

  const devices = Array.isArray(printerData?.devices) ? printerData.devices : [];

  // Group tasks by deviceId, latest first
  const tasksByDevice = {};
  for (const t of tasks) {
    const did = t?.deviceId;
    if (!did) continue;
    if (!tasksByDevice[did]) tasksByDevice[did] = [];
    tasksByDevice[did].push(t);
  }
  for (const did of Object.keys(tasksByDevice)) {
    tasksByDevice[did].sort(
      (a, b) => Date.parse(b?.startTime || 0) - Date.parse(a?.startTime || 0)
    );
  }

  return devices.map((dev, idx) => {
    const id = String(pick(dev, ["dev_id", "deviceId", "devId", "id"], `dev_${idx}`));
    const name = String(pick(dev, ["name", "dev_name", "devName"], "Unknown"));
    let status = resolveDeviceStatus(dev);

    // Check latest task for this device
    const latestTask = tasksByDevice[id]?.[0] || null;
    let jobTitle = String(pick(dev, ["subtask_name", "gcode_file", "task_name"], "") || "");
    let progressPct = null;
    let remainingSec = null;

    if (latestTask) {
      const taskTitle = latestTask.title || latestTask.designTitle || "";
      if (taskTitle) jobTitle = taskTitle;

      const start = Date.parse(latestTask.startTime);
      const costSec = Number(latestTask.costTime);
      const end = Date.parse(latestTask.endTime);
      const now = Date.now();

      // Compute progress from costTime or endTime
      if (!isNaN(start) && isFinite(costSec) && costSec > 0) {
        const plannedEnd = start + costSec * 1000;
        const diff = plannedEnd - now;
        if (diff > 0) {
          remainingSec = Math.floor(diff / 1000);
          progressPct = Math.min(100, Math.max(0, ((now - start) / (costSec * 1000)) * 100));
        } else {
          progressPct = 100;
          remainingSec = 0;
        }
      } else if (!isNaN(start) && !isNaN(end) && end > start) {
        const diff = end - now;
        if (diff > 0) {
          remainingSec = Math.floor(diff / 1000);
          progressPct = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
        } else {
          progressPct = 100;
          remainingSec = 0;
        }
      }

      // Determine status from device API + task data.
      // Device API (print_status) is real-time — trust it when it says printing/paused.
      // Only use task data to upgrade "online" → "printing" when taskStatus === 4.
      const deviceSaysActive = status === "printing" || status === "paused";
      if (!deviceSaysActive && latestTask.status === 4) {
        status = "printing";
      }
    }

    return { id, name, status, jobTitle, progressPct, remainingSec, taskStatus: latestTask?.status ?? null, taskId: latestTask?.id ? String(latestTask.id) : null };
  });
}

async function fetchMessages(accessToken, { type, after, limit = 20 } = {}) {
  const r = await axios.get(`${BAMBU_BASE}/v1/user-service/my/messages`, {
    timeout: 15000,
    params: {
      ...(type != null ? { type } : {}),
      ...(after ? { after } : {}),
      limit,
    },
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const data = r.data?.data ?? r.data;
  return Array.isArray(data?.hits) ? data.hits : [];
}

module.exports = { fetchPrinters, fetchTasks, fetchNormalizedPrinters, fetchMessages, pick };
