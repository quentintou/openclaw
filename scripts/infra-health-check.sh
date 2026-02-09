#!/usr/bin/env bash
# Infrastructure health checks for Effectual/OpenClaw.
# Designed for cron: */5 * * * * /path/to/infra-health-check.sh
set -euo pipefail

# SSH targets
VPS_HOST="${VPS_HOST:-exe.dev}"
HETZNER_HOST="${HETZNER_HOST:-hetzner}"

# Telegram alert config
ALERT_BOT_TOKEN="${ALERT_BOT_TOKEN:-}"
ALERT_CHAT_ID="${ALERT_CHAT_ID:-}"

# Redis config
REDIS_PORT="${REDIS_PORT:-6380}"

# Rate limiting: 1 alert per component per 15 minutes
ALERT_COOLDOWN=900
ALERT_STATE_DIR="/tmp"

# Expected minimum container count on Hetzner (0 = skip count check)
MIN_CONTAINERS="${MIN_CONTAINERS:-0}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

FAILURES=0
WARNINGS=0

check_pass() { printf "${GREEN}  ✓${RESET} %s\n" "$*"; }
check_fail() { printf "${RED}  ✗${RESET} %s\n" "$*"; FAILURES=$((FAILURES + 1)); }
check_warn() { printf "${YELLOW}  !${RESET} %s\n" "$*"; WARNINGS=$((WARNINGS + 1)); }
section()    { printf "\n${BOLD}${CYAN}[%s]${RESET}\n" "$*"; }

# Rate-limited Telegram alert
send_alert() {
  local component="$1"
  local message="$2"
  local state_file="${ALERT_STATE_DIR}/infra-health-last-alert-${component}"
  local now
  now=$(date +%s)

  # Check cooldown
  if [[ -f "$state_file" ]]; then
    local last_sent
    last_sent=$(cat "$state_file" 2>/dev/null || echo "0")
    if [[ $((now - last_sent)) -lt $ALERT_COOLDOWN ]]; then
      return 0
    fi
  fi

  # Send via Telegram bot API if configured
  if [[ -n "$ALERT_BOT_TOKEN" && -n "$ALERT_CHAT_ID" ]]; then
    local text
    text=$(printf "🚨 *Infra Alert* — %s\n\n%s\n\n_%s_" \
      "$component" "$message" "$(date '+%Y-%m-%d %H:%M:%S')")
    curl -s -o /dev/null -X POST \
      "https://api.telegram.org/bot${ALERT_BOT_TOKEN}/sendMessage" \
      -d chat_id="$ALERT_CHAT_ID" \
      -d parse_mode=Markdown \
      --data-urlencode text="$text" \
      || true
    echo "$now" > "$state_file"
  fi
}

# --- Redis ---
section "Redis (${VPS_HOST}:${REDIS_PORT})"

redis_ping=$(ssh "$VPS_HOST" \
  "redis-cli -p ${REDIS_PORT} -a \"\$REDIS_PASSWORD\" --no-auth-warning ping" 2>/dev/null || echo "FAIL")

if [[ "$redis_ping" == "PONG" ]]; then
  check_pass "Redis PING: PONG"
else
  check_fail "Redis PING failed (got: ${redis_ping})"
  send_alert "redis" "Redis PING failed on ${VPS_HOST}:${REDIS_PORT}"
fi

# Check eviction policy
eviction=$(ssh "$VPS_HOST" \
  "redis-cli -p ${REDIS_PORT} -a \"\$REDIS_PASSWORD\" --no-auth-warning config get maxmemory-policy" 2>/dev/null \
  | tail -1 || echo "unknown")

if [[ "$eviction" == "noeviction" ]]; then
  check_pass "Eviction policy: noeviction"
else
  check_warn "Eviction policy: ${eviction} (expected noeviction)"
  send_alert "redis-eviction" "Redis eviction policy is '${eviction}', expected 'noeviction'"
fi

# --- Engine Service ---
section "Engine Service (${VPS_HOST})"

engine_status=$(ssh "$VPS_HOST" "systemctl is-active effectual-engine" 2>/dev/null || echo "inactive")
if [[ "$engine_status" == "active" ]]; then
  check_pass "effectual-engine: active"
else
  check_fail "effectual-engine: ${engine_status}"
  send_alert "engine" "effectual-engine is ${engine_status} on ${VPS_HOST}"
fi

# --- Gateway Service ---
section "Gateway Service (${VPS_HOST})"

gateway_status=$(ssh "$VPS_HOST" "systemctl is-active openclaw-gateway" 2>/dev/null || echo "inactive")
if [[ "$gateway_status" == "active" ]]; then
  check_pass "openclaw-gateway: active"
else
  check_fail "openclaw-gateway: ${gateway_status}"
  send_alert "gateway" "openclaw-gateway is ${gateway_status} on ${VPS_HOST}"
fi

# --- Hetzner Containers ---
section "Hetzner Containers (${HETZNER_HOST})"

container_list=$(ssh "$HETZNER_HOST" \
  "docker ps --format '{{.Names}} ({{.Status}})'" 2>/dev/null || echo "")

if [[ -z "$container_list" ]]; then
  check_fail "Cannot list containers (SSH failed or none running)"
  send_alert "hetzner" "Cannot reach Hetzner or no containers running"
else
  container_count=$(echo "$container_list" | wc -l | tr -d ' ')
  check_pass "${container_count} container(s) running:"
  while IFS= read -r line; do
    printf "    %s\n" "$line"
  done <<< "$container_list"

  if [[ "$MIN_CONTAINERS" -gt 0 && "$container_count" -lt "$MIN_CONTAINERS" ]]; then
    check_warn "Expected at least ${MIN_CONTAINERS} containers, got ${container_count}"
    send_alert "hetzner-count" "Only ${container_count} containers running (expected >= ${MIN_CONTAINERS})"
  fi
fi

# --- Summary ---
printf "\n${BOLD}=== Health Check Summary ===${RESET}\n"
printf "  Timestamp: %s\n" "$(date '+%Y-%m-%d %H:%M:%S')"

if [[ "$FAILURES" -eq 0 && "$WARNINGS" -eq 0 ]]; then
  check_pass "All checks passed"
  exit 0
elif [[ "$FAILURES" -eq 0 ]]; then
  check_warn "${WARNINGS} warning(s), 0 failures"
  exit 0
else
  check_fail "${FAILURES} failure(s), ${WARNINGS} warning(s)"
  exit 1
fi
