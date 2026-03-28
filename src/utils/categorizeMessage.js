/**
 * Categorize a Bambu Cloud message the same way the app does.
 * Mirrors the logic from src/app/screens/NotificationsScreen.jsx lines 28-70.
 *
 * Returns { category, title, body }
 *   category: "warning" | "canceled" | "printing" | "completed" | "generic"
 */
function categorizeMessage(message) {
  const task = message?.taskMessage;
  if (!task) {
    return {
      category: "generic",
      title: "Notification",
      body: "New notification from Bambu Cloud",
    };
  }

  const detail = (task.detail || "").toLowerCase();
  const deviceLabel = task.deviceName || "Printer";
  const jobLabel = task.title || "Print job";

  // Warning keywords — same as app
  const isWarning =
    detail.includes("warn") ||
    detail.includes("error") ||
    detail.includes("fail") ||
    detail.includes("run out") ||
    detail.includes("ran out") ||
    detail.includes("insert") ||
    detail.includes("pause") ||
    detail.includes("jam") ||
    detail.includes("clog") ||
    detail.includes("tangle");

  if (isWarning) {
    return {
      category: "warning",
      title: `⚠️ ${deviceLabel}`,
      body: task.detail || `Issue detected on ${deviceLabel}`,
    };
  }

  // Canceled
  if (detail.includes("cancel")) {
    return {
      category: "canceled",
      title: `❌ ${jobLabel}`,
      body: task.detail || `Print was canceled on ${deviceLabel}`,
    };
  }

  // Printing (status === 4)
  if (task.status === 4) {
    return {
      category: "printing",
      title: `🖨 ${jobLabel}`,
      body: task.detail || `${deviceLabel} is printing`,
    };
  }

  // Completed (default)
  return {
    category: "completed",
    title: `✅ ${jobLabel}`,
    body: task.detail || `Print finished on ${deviceLabel}`,
  };
}

module.exports = { categorizeMessage };
