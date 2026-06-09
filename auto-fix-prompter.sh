#!/usr/bin/env bash
# auto-fix-prompter.sh
#
# Types "/fix" + Enter into the frontmost window every N seconds.
# Pauses automatically when VS Code (or whatever you set in TARGET_APP) is
# NOT the frontmost app, so you can use your computer for other things —
# when you switch back to VS Code with the Claude chat input focused, it
# resumes firing.
#
# Usage:
#   ./auto-fix-prompter.sh                # every 300s (5min), targets "Code"
#   ./auto-fix-prompter.sh 120            # every 120s
#   ./auto-fix-prompter.sh 60 "Cursor"    # every 60s, targets Cursor
#
# Stop with Ctrl+C.
#
# REQUIREMENTS:
#   - macOS
#   - Accessibility permission for whatever runs this script (usually
#     Terminal.app or iTerm). First run will trigger a permission prompt:
#     System Settings → Privacy & Security → Accessibility → enable Terminal.
#
# SAFETY:
#   - The script blindly sends "/fix" + Enter to the FOCUSED control. If
#     you have a code file focused inside VS Code (not the Claude chat
#     input), it'll type "/fix" into your code. KEEP THE CLAUDE CHAT INPUT
#     FOCUSED while VS Code is frontmost.
#   - Pressing Cmd+Tab away pauses the script. Switching to a different
#     app pauses it. Only when TARGET_APP is frontmost AND focused does it
#     fire.

set -u

INTERVAL_SECONDS="${1:-300}"
TARGET_APP="${2:-Code}"

# Sanity: must be macOS
if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script is macOS-only (uses AppleScript)." >&2
  exit 1
fi

# Sanity: osascript exists
if ! command -v osascript >/dev/null 2>&1; then
  echo "osascript not found — are you on macOS?" >&2
  exit 1
fi

echo "=========================================================="
echo "auto-fix-prompter"
echo "  interval: every ${INTERVAL_SECONDS}s ($((INTERVAL_SECONDS / 60))m)"
echo "  target:   $TARGET_APP (only fires when frontmost)"
echo ""
echo "  KEEP THE CLAUDE CHAT INPUT FOCUSED while $TARGET_APP is frontmost."
echo "  Click outside $TARGET_APP to pause. Stop with Ctrl+C."
echo "=========================================================="

# Catch Ctrl+C cleanly
trap 'echo ""; echo "stopped."; exit 0' INT TERM

TICK=0
SENT=0
SKIPPED=0

while true; do
  TICK=$((TICK + 1))

  # Get the name of the frontmost app
  FRONT=$(osascript -e 'tell application "System Events" to name of first application process whose frontmost is true' 2>/dev/null)

  TS=$(date '+%H:%M:%S')
  if [[ "$FRONT" == "$TARGET_APP" ]]; then
    SENT=$((SENT + 1))
    echo "[$TS] tick #$TICK — $FRONT frontmost — sending /fix  (sent=$SENT skipped=$SKIPPED)"
    # Type the literal text, then press return (key code 36)
    osascript \
      -e "tell application \"System Events\" to keystroke \"/fix\"" \
      -e 'delay 0.15' \
      -e 'tell application "System Events" to key code 36' \
      2>/dev/null || echo "  (osascript failed — accessibility permission?)"
  else
    SKIPPED=$((SKIPPED + 1))
    echo "[$TS] tick #$TICK — frontmost is '${FRONT:-unknown}', not '$TARGET_APP' — skipping  (sent=$SENT skipped=$SKIPPED)"
  fi

  sleep "$INTERVAL_SECONDS"
done
