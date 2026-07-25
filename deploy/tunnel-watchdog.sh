#!/bin/sh

set -u

local_url="${AI_PRESENTER_LOCAL_HEALTH_URL:-http://127.0.0.1:4317/api/health}"
public_url="${AI_PRESENTER_PUBLIC_HEALTH_URL:-https://aipresenterhub.com/api/health}"
state_dir="${AI_PRESENTER_WATCHDOG_STATE_DIR:-/Users/yshtola/ai-presenter-platform/runtime/tunnel-watchdog}"
failure_threshold="${AI_PRESENTER_TUNNEL_FAILURE_THRESHOLD:-2}"
restart_cooldown_seconds="${AI_PRESENTER_TUNNEL_RESTART_COOLDOWN_SECONDS:-180}"
launchd_label="${AI_PRESENTER_TUNNEL_LAUNCHD_LABEL:-com.ai-presenter.cloudflared}"
failure_file="$state_dir/failures"
restart_file="$state_dir/last-restart"

timestamp() {
  /bin/date -u '+%Y-%m-%dT%H:%M:%SZ'
}

read_number() {
  value=0
  if [ -f "$1" ]; then
    value=$(/bin/cat "$1" 2>/dev/null || true)
  fi
  case "$value" in
    ''|*[!0-9]*) value=0 ;;
  esac
  printf '%s' "$value"
}

/bin/mkdir -p "$state_dir"

# A tunnel restart cannot repair an unhealthy application. Avoid hiding a real
# backend failure behind repeated cloudflared restarts.
if ! /usr/bin/curl -fsS -o /dev/null --connect-timeout 2 --max-time 5 "$local_url"; then
  printf '%s local backend is unhealthy; tunnel restart skipped\n' "$(timestamp)"
  printf '0\n' > "$failure_file"
  exit 0
fi

if /usr/bin/curl -fsS -o /dev/null --connect-timeout 4 --max-time 10 "$public_url"; then
  printf '0\n' > "$failure_file"
  exit 0
fi

failures=$(read_number "$failure_file")
failures=$((failures + 1))
printf '%s\n' "$failures" > "$failure_file"
printf '%s public health check failed (%s/%s)\n' "$(timestamp)" "$failures" "$failure_threshold"

if [ "$failures" -lt "$failure_threshold" ]; then
  exit 0
fi

now=$(/bin/date '+%s')
last_restart=$(read_number "$restart_file")
since_restart=$((now - last_restart))
if [ "$since_restart" -lt "$restart_cooldown_seconds" ]; then
  printf '%s restart suppressed by cooldown (%ss remaining)\n' \
    "$(timestamp)" "$((restart_cooldown_seconds - since_restart))"
  exit 0
fi

service_target="gui/$(/usr/bin/id -u)/$launchd_label"
if /bin/launchctl kickstart -k "$service_target"; then
  printf '%s\n' "$now" > "$restart_file"
  printf '0\n' > "$failure_file"
  printf '%s restarted %s after consecutive public health failures\n' \
    "$(timestamp)" "$service_target"
else
  printf '%s failed to restart %s\n' "$(timestamp)" "$service_target" >&2
  exit 1
fi
