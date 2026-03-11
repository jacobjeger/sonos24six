#!/bin/bash
# Railway Log Monitor with Auto-Fix Triggering
# Usage: ./monitor.sh [--auto-fix] [--branch fix-branch-name]
#
# Prerequisites:
#   npm install -g @railway/cli
#   railway login
#   railway link
#
# This script tails Railway logs in real-time and detects errors.
# With --auto-fix, it triggers the auto-fix script when errors are found.

set -euo pipefail

AUTO_FIX=false
FIX_BRANCH="main"
LOG_FILE="auto-fix.log"
ERROR_BUFFER=""
ERROR_COUNT=0
COOLDOWN=60  # seconds between auto-fix attempts
LAST_FIX_TIME=0

while [[ $# -gt 0 ]]; do
  case $1 in
    --auto-fix) AUTO_FIX=true; shift ;;
    --branch) FIX_BRANCH="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

log_action() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" | tee -a "$LOG_FILE"
}

# Check Railway CLI
if ! command -v railway &> /dev/null; then
  echo "ERROR: Railway CLI not found. Install with: npm install -g @railway/cli"
  echo "Then run: railway login && railway link"
  exit 1
fi

# Verify Railway is linked
if ! railway status &> /dev/null 2>&1; then
  echo "ERROR: Railway project not linked. Run: railway link"
  exit 1
fi

log_action "ACTION: Starting log monitor | AUTO_FIX: $AUTO_FIX | BRANCH: $FIX_BRANCH"

# Error patterns to detect
declare -a ERROR_PATTERNS=(
  "UnhandledPromiseRejection"
  "Error:"
  "FATAL"
  "TypeError:"
  "ReferenceError:"
  "SyntaxError:"
  "Cannot read properties"
  "ECONNREFUSED"
  "ENOTFOUND"
  "handler error"
  "Login failed"
  "Could not parse"
)

detect_error() {
  local line="$1"
  for pattern in "${ERROR_PATTERNS[@]}"; do
    if echo "$line" | grep -qi "$pattern"; then
      return 0
    fi
  done
  return 1
}

trigger_fix() {
  local error_summary="$1"
  local now
  now=$(date +%s)
  local elapsed=$((now - LAST_FIX_TIME))

  if [ "$elapsed" -lt "$COOLDOWN" ]; then
    log_action "ACTION: Skipping fix (cooldown: ${elapsed}s/${COOLDOWN}s) | ERROR: $error_summary"
    return
  fi

  LAST_FIX_TIME=$now
  log_action "ACTION: Triggering auto-fix | ERROR: $error_summary"

  if [ -f "auto-fix.sh" ]; then
    bash auto-fix.sh "$error_summary" "$FIX_BRANCH" 2>&1 | tee -a "$LOG_FILE"
  else
    log_action "ACTION: auto-fix.sh not found, logging error only | ERROR: $error_summary"
  fi
}

echo "Tailing Railway logs... (Ctrl+C to stop)"
echo "---"

# Tail Railway logs and process each line
railway logs --tail 2>&1 | while IFS= read -r line; do
  # Print the log line
  echo "$line"

  # Check for errors
  if detect_error "$line"; then
    ERROR_COUNT=$((ERROR_COUNT + 1))
    ERROR_BUFFER="$line"

    # Extract a summary (first 120 chars)
    error_summary="${line:0:120}"

    echo ""
    echo "⚠ ERROR DETECTED (#$ERROR_COUNT): $error_summary"
    echo ""

    if [ "$AUTO_FIX" = true ]; then
      trigger_fix "$error_summary"
    fi
  fi
done

log_action "ACTION: Monitor stopped | ERRORS_DETECTED: $ERROR_COUNT"
