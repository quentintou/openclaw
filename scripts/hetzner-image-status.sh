#!/usr/bin/env bash
# Show Docker image versions per client on Hetzner.
# Compares running image tags against the latest available tag.
set -euo pipefail

HETZNER_HOST="${HETZNER_HOST:-hetzner}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log()  { printf "${CYAN}==>${RESET} %s\n" "$*"; }
fail() { printf "${RED}  ✗ ERROR:${RESET} %s\n" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Show Docker image versions per client container on Hetzner.

Options:
  --no-color    Disable colored output
  -h, --help    Show this help

Environment:
  HETZNER_HOST  SSH host alias for Hetzner (default: hetzner)
EOF
  exit 0
}

NO_COLOR=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-color)  NO_COLOR=1; shift ;;
    -h|--help)   usage ;;
    *)           fail "Unknown option: $1" ;;
  esac
done

if [[ "$NO_COLOR" -eq 1 ]]; then
  RED='' GREEN='' YELLOW='' CYAN='' BOLD='' RESET=''
fi

log "Connecting to ${HETZNER_HOST}..."

# Fetch container names and their full image references
CONTAINER_DATA=$(ssh "$HETZNER_HOST" \
  "docker ps --format '{{.Names}}|{{.Image}}|{{.ID}}'" 2>/dev/null) \
  || fail "Cannot connect to ${HETZNER_HOST} via SSH"

if [[ -z "$CONTAINER_DATA" ]]; then
  fail "No running containers found on ${HETZNER_HOST}"
fi

UP_TO_DATE=0
OUTDATED=0
UNKNOWN=0
TOTAL=0

printf "\n${BOLD}%-20s %-45s %-45s %s${RESET}\n" "CONTAINER" "RUNNING IMAGE" "LATEST AVAILABLE" "STATUS"
printf "%-20s %-45s %-45s %s\n" "--------" "-------------" "----------------" "------"

while IFS='|' read -r name image id; do
  TOTAL=$((TOTAL + 1))

  # Get the image digest of the running container
  running_digest=$(ssh "$HETZNER_HOST" \
    "docker inspect --format='{{.Image}}' '$name'" 2>/dev/null | cut -c1-19 || echo "unknown")

  # Try to get latest digest by pulling (dry-run style: just check, don't actually replace)
  # We compare the RepoDigests of running vs registry
  latest_info=$(ssh "$HETZNER_HOST" bash -s <<REMOTE_SCRIPT
    # Pull quietly to check for updates (pull downloads but doesn't restart)
    pull_output=\$(docker pull "$image" 2>&1)
    if echo "\$pull_output" | grep -q "Image is up to date"; then
      echo "UP_TO_DATE"
    elif echo "\$pull_output" | grep -q "Downloaded newer image"; then
      echo "OUTDATED"
    else
      echo "UNKNOWN"
    fi
REMOTE_SCRIPT
  ) || latest_info="UNKNOWN"

  # Extract just the tag portion for display
  image_short="$image"
  if [[ ${#image_short} -gt 44 ]]; then
    image_short="${image_short:0:41}..."
  fi

  case "$latest_info" in
    UP_TO_DATE)
      UP_TO_DATE=$((UP_TO_DATE + 1))
      status="${GREEN}up to date${RESET}"
      ;;
    OUTDATED)
      OUTDATED=$((OUTDATED + 1))
      status="${YELLOW}outdated${RESET}"
      ;;
    *)
      UNKNOWN=$((UNKNOWN + 1))
      status="${RED}unknown${RESET}"
      ;;
  esac

  printf "%-20s %-45s %-45s %b\n" "$name" "$image_short" "${image_short}" "$status"

done <<< "$CONTAINER_DATA"

# Summary
printf "\n${BOLD}=== Image Status Summary ===${RESET}\n"
printf "  Total containers:  %d\n" "$TOTAL"
printf "  ${GREEN}Up to date:${RESET}        %d\n" "$UP_TO_DATE"
if [[ "$OUTDATED" -gt 0 ]]; then
  printf "  ${YELLOW}Outdated:${RESET}          %d\n" "$OUTDATED"
fi
if [[ "$UNKNOWN" -gt 0 ]]; then
  printf "  ${RED}Unknown:${RESET}           %d\n" "$UNKNOWN"
fi

printf "\n  ${BOLD}%d/%d${RESET} containers on latest image\n" "$UP_TO_DATE" "$TOTAL"

if [[ "$OUTDATED" -gt 0 ]]; then
  printf "\n  ${YELLOW}Tip:${RESET} Run ${BOLD}./scripts/hetzner-deploy.sh --all${RESET} to update outdated containers.\n"
fi
