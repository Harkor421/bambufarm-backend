/**
 * The Live Activity content-state, built in ONE place for every send path
 * (start, progress ticks, pause/resume, first-connect recovery).
 *
 * startTime is back-dated so that (now - start) / (end - start) == progress at
 * send time. The widget (app ≥ the "Live Activities v2" build) draws its bar
 * from that timer range, so the bar shows the real % and keeps moving between
 * pushes — even when no push can reach the card. Older widgets only use
 * endTime (countdown) and `progress`, so this stays backward compatible.
 *
 * Same formula as WidgetBridge.timelineStart in plugins/withWidgetBridge.js.
 */

function timelineStart(progress, endSec, nowSec) {
  if (!(progress > 0.001 && progress < 0.999) || !(endSec > nowSec)) return nowSec;
  return Math.round(nowSec - (progress * (endSec - nowSec)) / (1 - progress));
}

function buildContentState({ jobTitle, progress, remainingSec, status, nowSec = Math.floor(Date.now() / 1000) }) {
  const p = Math.min(1, Math.max(0, Number(progress) || 0));
  const endTime = remainingSec > 0 ? nowSec + Math.round(remainingSec) : nowSec;
  const startTime = status === "printing" ? timelineStart(p, endTime, nowSec) : nowSec;
  return { jobTitle: jobTitle || "Print Job", progress: p, startTime, endTime, status, updatedAt: nowSec };
}

/**
 * When a printing card should turn "stale": 15 min past its estimated finish
 * (never sooner than 10 min from now). Until then the card animates itself;
 * after that, if no newer push arrived, the widget says "Likely done" instead
 * of claiming to still print. Non-printing states don't go stale.
 */
function staleAfterSecFor(state, nowSec = Math.floor(Date.now() / 1000)) {
  if (!state || state.status !== "printing") return 0;
  return Math.max(600, state.endTime - nowSec + 900);
}

module.exports = { buildContentState, staleAfterSecFor, timelineStart };
