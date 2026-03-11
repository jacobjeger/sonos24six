#!/bin/bash
# Auto-Fix Script for Railway-deployed Node.js project
# Called by monitor.sh when an error is detected
# Usage: ./auto-fix.sh "error summary" [branch]

set -euo pipefail

ERROR_SUMMARY="${1:-unknown error}"
FIX_BRANCH="${2:-main}"
LOG_FILE="auto-fix.log"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

log_action() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" | tee -a "$LOG_FILE"
}

cd "$PROJECT_DIR"

log_action "ACTION: Auto-fix started | ERROR: $ERROR_SUMMARY"

# Map error patterns to relevant source files
get_relevant_files() {
  local error="$1"
  local files=""

  case "$error" in
    *"proxy"*|*"stream"*|*"MPEG"*|*"ADTS"*|*"audio"*)
      files="src/proxy.js src/handlers/getMediaURI.js"
      ;;
    *"auth"*|*"login"*|*"Login"*|*"cookie"*|*"XSRF"*)
      files="src/auth.js src/client.js"
      ;;
    *"soap"*|*"SOAP"*|*"dispatch"*)
      files="src/soap.js"
      ;;
    *"xml"*|*"XML"*|*"mediaMetadata"*|*"mediaCollection"*)
      files="src/xml.js"
      ;;
    *"getMetadata"*|*"browse"*|*"playlist"*|*"album"*|*"artist"*)
      files="src/handlers/getMetadata.js src/client.js"
      ;;
    *"getMediaURI"*|*"getStreamUrl"*|*"stream_url"*)
      files="src/handlers/getMediaURI.js src/client.js src/proxy.js"
      ;;
    *"search"*)
      files="src/handlers/search.js src/client.js"
      ;;
    *"server"*|*"express"*|*"listen"*|*"port"*)
      files="src/server.js"
      ;;
    *)
      files="src/server.js src/soap.js src/client.js"
      ;;
  esac

  echo "$files"
}

# Run tests if they exist
run_tests() {
  if [ -f "package.json" ] && grep -q '"test"' package.json; then
    log_action "ACTION: Running tests"
    if npm test 2>&1; then
      log_action "RESULT: Tests passed"
      return 0
    else
      log_action "RESULT: Tests FAILED - aborting fix"
      return 1
    fi
  else
    log_action "ACTION: No tests configured, skipping"
    return 0
  fi
}

# Attempt fix using Claude Code (if available) or log for manual fix
attempt_fix() {
  local error="$1"
  local files
  files=$(get_relevant_files "$error")

  log_action "ACTION: Analyzing error | FILES: $files | ERROR: $error"

  # Check if claude CLI is available for autonomous fixing
  if command -v claude &> /dev/null; then
    log_action "ACTION: Invoking Claude Code for autonomous fix"

    # Create a prompt for Claude Code
    local prompt="Fix this error in the Railway-deployed Node.js Sonos SMAPI bridge. Error: $error. Relevant files: $files. Follow the rules in CLAUDE.md. Make minimal changes to fix the issue."

    # Run Claude Code in non-interactive mode
    claude --print "$prompt" 2>&1 | tee -a "$LOG_FILE"

    # Check if files were modified
    if git diff --quiet; then
      log_action "RESULT: No code changes made by Claude"
      return 1
    fi

    # Run tests before committing
    if ! run_tests; then
      log_action "RESULT: Tests failed after fix - reverting"
      git checkout -- .
      return 1
    fi

    # Commit and push
    local commit_msg="fix: auto-resolved $(echo "$error" | head -c 72)"
    git add -A
    git commit -m "$commit_msg"

    if [ "$FIX_BRANCH" = "main" ]; then
      git push origin main
      log_action "RESULT: Fix pushed to main | COMMIT: $(git rev-parse --short HEAD)"
    else
      git checkout -b "$FIX_BRANCH" 2>/dev/null || git checkout "$FIX_BRANCH"
      git push -u origin "$FIX_BRANCH"
      log_action "RESULT: Fix pushed to $FIX_BRANCH | COMMIT: $(git rev-parse --short HEAD)"
    fi

    return 0
  else
    log_action "ACTION: Claude CLI not available - logging error for manual fix"
    log_action "MANUAL_FIX_NEEDED: $error | FILES: $files"
    return 1
  fi
}

# Main flow
attempt_fix "$ERROR_SUMMARY"
exit_code=$?

if [ $exit_code -eq 0 ]; then
  log_action "ACTION: Auto-fix completed successfully"
else
  log_action "ACTION: Auto-fix could not resolve the issue automatically"
fi

exit $exit_code
