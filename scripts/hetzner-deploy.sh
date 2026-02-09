#!/usr/bin/env bash
# Rolling restart of Hetzner Docker containers with health checks.
# Usage: ./scripts/hetzner-deploy.sh --all
#        ./scripts/hetzner-deploy.sh hugo maxime
set -euo pipefail

HETZNER_HOST="${HETZNER_HOST:-hetzner}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log()  { printf "${CYAN}==>${RESET} %s\n" "$*"; }
ok()   { printf "${GREEN}  ✓${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}  !${RESET} %s\n" "$*"; }
fail() { printf "${RED}  ✗ ERROR:${RESET} %s\n" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS] [container-names...]

Rolling deploy of Hetzner Docker containers.

Options:
  --all         Restart all running containers
  --dry-run     Show what would be done without acting
  --timeout N   Health check timeout in seconds (default: $HEALTH_TIMEOUT)
  -h, --help    Show this help

Environment:
  HETZNER_HOST  SSH host alias for Hetzner (default: hetzner)
  HEALTH_TIMEOUT  Seconds to wait for healthy status (default: 60)

Examples:
  $(basename "$0") --all
  $(basename "$0") hugo maxime
  $(basename "$0") --dry-run --all
EOF
  exit 0
}

DEPLOY_ALL=0
DRY_RUN=0
TARGETS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)       DEPLOY_ALL=1; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    --timeout)   HEALTH_TIMEOUT="${2:?--timeout requires a value}"; shift 2 ;;
    -h|--help)   usage ;;
    -*)          fail "Unknown option: $1" ;;
    *)           TARGETS+=("$1"); shift ;;
  esac
done

if [[ "$DEPLOY_ALL" -eq 0 && ${#TARGETS[@]} -eq 0 ]]; then
  fail "Specify --all or one or more container names. Use --help for usage."
fi

# Fetch running containers from Hetzner
log "Connecting to ${HETZNER_HOST}..."
RUNNING_CONTAINERS=$(ssh "$HETZNER_HOST" \
  "docker ps --format '{{.Names}}|{{.Image}}|{{.ID}}'" 2>/dev/null) \
  || fail "Cannot connect to ${HETZNER_HOST} via SSH"

if [[ -z "$RUNNING_CONTAINERS" ]]; then
  fail "No running containers found on ${HETZNER_HOST}"
fi

log "Running containers on ${HETZNER_HOST}:"
while IFS='|' read -r name image id; do
  printf "  ${BOLD}%-20s${RESET} image=%-40s id=%s\n" "$name" "$image" "$id"
done <<< "$RUNNING_CONTAINERS"

# Build deploy list
DEPLOY_LIST=()
if [[ "$DEPLOY_ALL" -eq 1 ]]; then
  while IFS='|' read -r name _ _; do
    DEPLOY_LIST+=("$name")
  done <<< "$RUNNING_CONTAINERS"
else
  for target in "${TARGETS[@]}"; do
    if ! grep -q "^${target}|" <<< "$RUNNING_CONTAINERS"; then
      fail "Container '${target}' is not running on ${HETZNER_HOST}"
    fi
    DEPLOY_LIST+=("$target")
  done
fi

log "Deploy plan: ${DEPLOY_LIST[*]} (${#DEPLOY_LIST[@]} containers)"
if [[ "$DRY_RUN" -eq 1 ]]; then
  warn "Dry run -- no changes will be made"
fi

SUCCEEDED=0
FAILED=0

for container in "${DEPLOY_LIST[@]}"; do
  printf "\n${BOLD}--- Deploying: %s ---${RESET}\n" "$container"

  # Get current container config (image, ports, env, volumes, restart policy)
  CONTAINER_IMAGE=$(ssh "$HETZNER_HOST" \
    "docker inspect --format='{{.Config.Image}}' '$container'" 2>/dev/null) \
    || fail "Cannot inspect container '$container'"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "Would pull ${CONTAINER_IMAGE}, stop/rm ${container}, recreate, health check"
    ok "Dry run: ${container} skipped"
    continue
  fi

  # Pull latest image
  log "Pulling ${CONTAINER_IMAGE}..."
  ssh "$HETZNER_HOST" "docker pull '${CONTAINER_IMAGE}'" \
    || fail "Failed to pull image for ${container}"
  ok "Image pulled"

  # Capture full run config before stopping
  # We use docker inspect to get ports, env, volumes, restart policy, network
  RUN_ARGS=$(ssh "$HETZNER_HOST" bash -s <<'REMOTE_SCRIPT'
    name="$1"
    args=""

    # Restart policy
    restart=$(docker inspect --format='{{.HostConfig.RestartPolicy.Name}}' "$name" 2>/dev/null)
    if [[ -n "$restart" && "$restart" != "no" ]]; then
      max=$(docker inspect --format='{{.HostConfig.RestartPolicy.MaximumRetryCount}}' "$name" 2>/dev/null)
      if [[ "$max" -gt 0 ]]; then
        args="$args --restart=${restart}:${max}"
      else
        args="$args --restart=${restart}"
      fi
    fi

    # Port mappings
    ports=$(docker inspect --format='{{range $p, $conf := .NetworkSettings.Ports}}{{range $conf}}{{.HostPort}}:{{$p}} {{end}}{{end}}' "$name" 2>/dev/null | tr -s ' ')
    for mapping in $ports; do
      args="$args -p $mapping"
    done

    # Environment variables
    while IFS= read -r env; do
      [[ -n "$env" ]] && args="$args -e $(printf '%q' "$env")"
    done < <(docker inspect --format='{{range .Config.Env}}{{println .}}{{end}}' "$name" 2>/dev/null)

    # Volume mounts
    while IFS= read -r vol; do
      [[ -n "$vol" ]] && args="$args -v $vol"
    done < <(docker inspect --format='{{range .Mounts}}{{.Source}}:{{.Destination}}{{if ne .Mode ""}}:{{.Mode}}{{end}} {{end}}' "$name" 2>/dev/null | tr ' ' '\n')

    # Network mode (skip default bridge)
    network=$(docker inspect --format='{{.HostConfig.NetworkMode}}' "$name" 2>/dev/null)
    if [[ -n "$network" && "$network" != "default" && "$network" != "bridge" ]]; then
      args="$args --network=$network"
    fi

    echo "$args"
REMOTE_SCRIPT
  ) || fail "Failed to capture config for ${container}"

  # Stop and remove
  log "Stopping ${container}..."
  ssh "$HETZNER_HOST" "docker stop '${container}'" \
    || fail "Failed to stop ${container}"
  ok "Stopped"

  ssh "$HETZNER_HOST" "docker rm '${container}'" \
    || fail "Failed to remove ${container}"
  ok "Removed"

  # Recreate with same config
  log "Recreating ${container}..."
  ssh "$HETZNER_HOST" \
    "docker run -d --name '${container}' ${RUN_ARGS} '${CONTAINER_IMAGE}'" \
    || { FAILED=$((FAILED + 1)); printf "${RED}  ✗ Failed to recreate ${container}${RESET}\n"; continue; }
  ok "Recreated"

  # Health check: wait for container to be running/healthy
  log "Waiting for health check (up to ${HEALTH_TIMEOUT}s)..."
  elapsed=0
  healthy=0
  while [[ $elapsed -lt $HEALTH_TIMEOUT ]]; do
    status=$(ssh "$HETZNER_HOST" \
      "docker inspect --format='{{.State.Status}}' '${container}'" 2>/dev/null || echo "unknown")
    health=$(ssh "$HETZNER_HOST" \
      "docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' '${container}'" 2>/dev/null || echo "unknown")

    if [[ "$status" != "running" ]]; then
      fail "Container ${container} is not running (status: ${status})"
    fi

    # If no health check configured, running is good enough
    if [[ "$health" == "none" || "$health" == "healthy" ]]; then
      healthy=1
      break
    fi

    if [[ "$health" == "unhealthy" ]]; then
      break
    fi

    sleep 2
    elapsed=$((elapsed + 2))
  done

  if [[ "$healthy" -eq 1 ]]; then
    ok "Health check passed for ${container}"
    SUCCEEDED=$((SUCCEEDED + 1))
  else
    printf "${RED}  ✗ Health check failed for ${container} (status: ${health})${RESET}\n" >&2
    FAILED=$((FAILED + 1))
    fail "Aborting rolling deploy -- ${container} failed health check"
  fi
done

# Summary
printf "\n${BOLD}=== Deploy Summary ===${RESET}\n"
printf "  ${GREEN}Succeeded:${RESET} %d\n" "$SUCCEEDED"
if [[ "$FAILED" -gt 0 ]]; then
  printf "  ${RED}Failed:${RESET}    %d\n" "$FAILED"
  exit 1
fi
ok "All containers deployed successfully"
