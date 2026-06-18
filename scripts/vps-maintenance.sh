#!/bin/bash
# VPS ops monitor: health checks, resource alerts, suspicious activity scan,
# Docker cleanup, and Telegram notifications.
# Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from project .env.
#
# Usage: vps-maintenance.sh {monitor|prune|test|summary}

set -u

PROJECT_NAME="${PROJECT_NAME:-douyin-scraper}"
PROJECT_DIR="${PROJECT_DIR:-/home/ubuntu/Project/douyin-scraper}"
COMPOSE_FILE="${COMPOSE_FILE:-${PROJECT_DIR}/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-${PROJECT_DIR}/.env}"

DISK_ALERT_THRESHOLD="${DISK_ALERT_THRESHOLD:-85}"
MEM_ALERT_THRESHOLD="${MEM_ALERT_THRESHOLD:-85}"
SWAP_ALERT_THRESHOLD="${SWAP_ALERT_THRESHOLD:-50}"
LOAD_ALERT_THRESHOLD="${LOAD_ALERT_THRESHOLD:-}"
RESTART_ALERT_THRESHOLD="${RESTART_ALERT_THRESHOLD:-3}"
SUSPICIOUS_AUTH_THRESHOLD="${SUSPICIOUS_AUTH_THRESHOLD:-10}"
APP_ERROR_THRESHOLD="${APP_ERROR_THRESHOLD:-8}"
MONITOR_LOG_LOOKBACK="${MONITOR_LOG_LOOKBACK:-15m}"
ALERT_COOLDOWN_SECONDS="${ALERT_COOLDOWN_SECONDS:-3600}"
MONITOR_HEALTH_URLS="${MONITOR_HEALTH_URLS:-http://127.0.0.1:3000/api/health}"
MONITOR_IGNORE_CONTAINERS="${MONITOR_IGNORE_CONTAINERS:-}"
STATE_DIR="${STATE_DIR:-/var/lib/vps-monitor-${PROJECT_NAME}}"

HOSTNAME=$(hostname)
IP=$(hostname -I 2>/dev/null | awk '{print $1}')

if [ -f "$ENV_FILE" ]; then
  TELEGRAM_BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
  TELEGRAM_CHAT_ID=$(grep -E '^TELEGRAM_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  STATE_DIR="/tmp/vps-monitor-${PROJECT_NAME}"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
fi

html_escape() {
  if [ "$#" -gt 0 ]; then
    printf '%s' "$1"
  else
    cat
  fi | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'
}

send_tg() {
  local text="$1"
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "[skip telegram] missing creds"
    return
  fi
  curl -s --max-time 10 \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "parse_mode=HTML" \
    --data-urlencode "text=${text}" > /dev/null || true
}

safe_key() {
  printf '%s' "$1" | cksum | awk '{print $1}'
}

notify_state() {
  local key="$1"
  local state="$2"
  local title="$3"
  local body="$4"
  local k now prev last should_send
  k=$(safe_key "$key")
  now=$(date +%s)
  prev=$(cat "${STATE_DIR}/${k}.state" 2>/dev/null || echo "unknown")
  last=$(cat "${STATE_DIR}/${k}.sent" 2>/dev/null || echo "0")
  should_send=0

  if [ "$state" != "$prev" ]; then
    should_send=1
    if [ "$prev" = "unknown" ] && [ "$state" = "ok" ]; then
      should_send=0
    fi
  elif [ "$state" != "ok" ] && [ $((now - last)) -ge "$ALERT_COOLDOWN_SECONDS" ]; then
    should_send=1
  fi

  echo "$state" > "${STATE_DIR}/${k}.state" 2>/dev/null || true

  if [ "$should_send" -eq 1 ]; then
    echo "$now" > "${STATE_DIR}/${k}.sent" 2>/dev/null || true
    send_tg "<b>${title}</b>
Project: <code>${PROJECT_NAME}</code>
Host: <code>${HOSTNAME}</code> (${IP})
Time: $(date '+%Y-%m-%d %H:%M:%S %Z')

${body}"
    echo "[alert] ${key}: ${state}"
  else
    echo "[state] ${key}: ${state}"
  fi
}

debug_commands() {
  cat <<EOF
<b>Debug nhanh:</b>
<pre>cd ${PROJECT_DIR}
docker compose ps
docker compose logs --tail=120
docker stats --no-stream
df -h /
free -h
journalctl --since "-30 minutes" -p warning --no-pager</pre>
EOF
}

compose_cmd() {
  if [ -f "$COMPOSE_FILE" ]; then
    cd "$PROJECT_DIR" 2>/dev/null && docker compose -f "$COMPOSE_FILE" "$@"
  else
    return 1
  fi
}

is_ignored_container() {
  local name="$1"
  IFS=',' read -r -a items <<< "$MONITOR_IGNORE_CONTAINERS"
  for item in "${items[@]}"; do
    [ "$name" = "$item" ] && return 0
  done
  return 1
}

check_disk() {
  local used avail top docker_df body
  used=$(df / | awk 'NR==2 {gsub("%",""); print $5}')
  avail=$(df -h / | awk 'NR==2 {print $4}')
  if [ "$used" -ge "$DISK_ALERT_THRESHOLD" ]; then
    top=$(du -h -d 1 /var /home 2>/dev/null | sort -hr | head -10 | sed 's/^/  /')
    docker_df=$(docker system df 2>/dev/null | tail -n +2 | sed 's/^/  /')
    body="Disk used: <b>${used}%</b> (free: ${avail})

<b>Top dirs:</b>
<pre>$(html_escape "$top")</pre>
<b>Docker:</b>
<pre>$(html_escape "$docker_df")</pre>
$(debug_commands)"
    notify_state "disk" "alert" "VPS Disk Alert" "$body"
  else
    notify_state "disk" "ok" "VPS Disk Recovered" "Disk used: ${used}% (free: ${avail})"
  fi
}

check_memory() {
  local mem swap body
  mem=$(free | awk '/Mem:/ {if ($2 > 0) printf "%.0f", (($2-$7)*100)/$2; else print 0}')
  swap=$(free | awk '/Swap:/ {if ($2 > 0) printf "%.0f", ($3*100)/$2; else print 0}')
  if [ "$mem" -ge "$MEM_ALERT_THRESHOLD" ] || [ "$swap" -ge "$SWAP_ALERT_THRESHOLD" ]; then
    body="Memory used: <b>${mem}%</b>
Swap used: <b>${swap}%</b>

<b>Top processes:</b>
<pre>$(ps -eo pid,ppid,comm,%mem,%cpu --sort=-%mem | head -12 | html_escape)</pre>
<b>Memory:</b>
<pre>$(free -h | html_escape)</pre>
$(debug_commands)"
    notify_state "memory" "alert" "VPS Memory Alert" "$body"
  else
    notify_state "memory" "ok" "VPS Memory Recovered" "Memory used: ${mem}%, swap used: ${swap}%"
  fi
}

check_load() {
  local cores threshold load over body
  cores=$(nproc 2>/dev/null || echo 1)
  threshold="${LOAD_ALERT_THRESHOLD}"
  if [ -z "$threshold" ]; then
    threshold=$((cores * 2))
  fi
  load=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
  over=$(awk -v l="$load" -v t="$threshold" 'BEGIN {print (l > t) ? 1 : 0}')
  if [ "$over" -eq 1 ]; then
    body="Load average 1m: <b>${load}</b>
CPU cores: ${cores}
Threshold: ${threshold}

<b>Top CPU:</b>
<pre>$(ps -eo pid,ppid,comm,%cpu,%mem --sort=-%cpu | head -12 | html_escape)</pre>
$(debug_commands)"
    notify_state "load" "alert" "VPS Load Alert" "$body"
  else
    notify_state "load" "ok" "VPS Load Recovered" "Load average 1m: ${load}, threshold: ${threshold}"
  fi
}

check_health_urls() {
  local url code key body
  IFS=',' read -r -a urls <<< "$MONITOR_HEALTH_URLS"
  for url in "${urls[@]}"; do
    url=$(printf '%s' "$url" | xargs)
    [ -z "$url" ] && continue
    code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
    key="health:${url}"
    if [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; then
      notify_state "$key" "ok" "Health Check Recovered" "URL: <code>${url}</code>
HTTP: <b>${code}</b>"
    else
      body="URL: <code>${url}</code>
HTTP: <b>${code}</b>
$(debug_commands)"
      notify_state "$key" "alert" "Health Check Failed" "$body"
    fi
  done
}

check_docker() {
  local ps_out bad restart_lines name status restarts body
  ps_out=$(compose_cmd ps -a --format '{{.Name}}|{{.Status}}' 2>/dev/null || docker ps -a --format '{{.Names}}|{{.Status}}' 2>/dev/null || true)
  bad=""
  restart_lines=""

  while IFS='|' read -r name status; do
    [ -z "$name" ] && continue
    is_ignored_container "$name" && continue
    if printf '%s' "$status" | grep -Eiq 'unhealthy|restarting|exited|dead'; then
      bad="${bad}${name} | ${status}
"
    fi
    restarts=$(docker inspect -f '{{.RestartCount}}' "$name" 2>/dev/null || echo 0)
    if [ "$restarts" -ge "$RESTART_ALERT_THRESHOLD" ]; then
      restart_lines="${restart_lines}${name} restarts=${restarts}
"
    fi
  done <<< "$ps_out"

  if [ -n "$bad$restart_lines" ]; then
    body="<b>Bad containers:</b>
<pre>$(html_escape "$bad")</pre>
<b>High restart count:</b>
<pre>$(html_escape "$restart_lines")</pre>
$(debug_commands)"
    notify_state "docker" "alert" "Docker Container Alert" "$body"
  else
    notify_state "docker" "ok" "Docker Containers Recovered" "All monitored containers look healthy."
  fi
}

check_suspicious_activity() {
  local auth_count oom_count app_errors body logs
  auth_count=$(journalctl --since "-${MONITOR_LOG_LOOKBACK}" --no-pager 2>/dev/null \
    | grep -Eai 'Failed password|Invalid user|authentication failure|POSSIBLE BREAK-IN' \
    | wc -l | tr -d ' ')
  oom_count=$(journalctl -k --since "-${MONITOR_LOG_LOOKBACK}" --no-pager 2>/dev/null \
    | grep -Eai 'out of memory|oom-killer|killed process' \
    | wc -l | tr -d ' ')
  logs=$(compose_cmd logs --since "${MONITOR_LOG_LOOKBACK}" --no-color 2>/dev/null \
    | grep -Eai 'panic|fatal|traceback|out of memory|oom|segmentation fault|database is locked|too many connections|connection refused|rate limit|csrf|sql injection|/wp-admin|/phpmyadmin' \
    | tail -30 || true)
  app_errors=$(printf '%s' "$logs" | sed '/^$/d' | wc -l | tr -d ' ')

  if [ "$auth_count" -ge "$SUSPICIOUS_AUTH_THRESHOLD" ] || [ "$oom_count" -gt 0 ] || [ "$app_errors" -ge "$APP_ERROR_THRESHOLD" ]; then
    body="Auth failures (${MONITOR_LOG_LOOKBACK}): <b>${auth_count}</b>
Kernel OOM events: <b>${oom_count}</b>
App suspicious/error lines: <b>${app_errors}</b>

<b>Recent matching app logs:</b>
<pre>$(html_escape "$logs")</pre>
$(debug_commands)"
    notify_state "suspicious" "alert" "Suspicious Activity Alert" "$body"
  else
    notify_state "suspicious" "ok" "Suspicious Activity Recovered" "No suspicious threshold exceeded in last ${MONITOR_LOG_LOOKBACK}."
  fi
}

monitor_all() {
  check_disk
  check_memory
  check_load
  check_health_urls
  check_docker
  check_suspicious_activity
}

case "${1:-monitor}" in
  monitor)
    monitor_all
    ;;

  summary)
    send_tg "<b>VPS Monitor Summary</b>
Project: <code>${PROJECT_NAME}</code>
Host: <code>${HOSTNAME}</code> (${IP})
Time: $(date '+%Y-%m-%d %H:%M:%S %Z')

<pre>$(df -h / | html_escape)

$(free -h | html_escape)

$(compose_cmd ps 2>/dev/null | html_escape)</pre>"
    echo "[summary sent]"
    ;;

  prune)
    BEFORE=$(df -h / | awk 'NR==2 {print $3" used, "$4" free ("$5")"}')
    IMG=$(docker image prune -af --filter "until=168h" 2>&1 | grep "Total reclaimed" || echo "Images: 0")
    BUILD=$(docker builder prune -af --filter "unused-for=168h" 2>&1 | grep "Total" || echo "Build cache: 0")

    for f in /var/lib/docker/containers/*/*-json.log; do
      [ -f "$f" ] && truncate -s 0 "$f"
    done

    journalctl --vacuum-time=14d > /dev/null 2>&1
    [ -f /var/log/btmp ] && truncate -s 0 /var/log/btmp
    [ -f /var/log/btmp.1 ] && truncate -s 0 /var/log/btmp.1
    find /var/log -name "*.gz" -mtime +14 -delete 2>/dev/null
    find /var/log -name "*.1" -mtime +14 -delete 2>/dev/null

    AFTER=$(df -h / | awk 'NR==2 {print $3" used, "$4" free ("$5")"}')
    send_tg "<b>VPS Weekly Cleanup</b>
Project: <code>${PROJECT_NAME}</code>
Host: <code>${HOSTNAME}</code> (${IP})

Before: ${BEFORE}
After:  ${AFTER}

<pre>$(html_escape "${IMG}
${BUILD}")</pre>"
    echo "[prune done] $AFTER"
    ;;

  test)
    send_tg "<b>VPS Monitor Test</b>
Project: <code>${PROJECT_NAME}</code>
Host: <code>${HOSTNAME}</code> (${IP})
Time: $(date '+%Y-%m-%d %H:%M:%S %Z')

Telegram alerts wired correctly."
    echo "[test sent]"
    ;;

  *)
    echo "Usage: $0 {monitor|prune|test|summary}"
    exit 1
    ;;
esac
