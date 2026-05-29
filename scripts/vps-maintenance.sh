#!/bin/bash
# VPS maintenance: disk monitor + docker prune
# Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from project .env
#
# Install: see scripts/install-vps-maintenance.sh
# Usage:   vps-maintenance.sh {monitor|prune|test}

set -u

ENV_FILE="${ENV_FILE:-/home/ubuntu/Project/douyin-scraper/.env}"
ALERT_THRESHOLD="${ALERT_THRESHOLD:-85}"  # percent
HOSTNAME=$(hostname)
IP=$(hostname -I 2>/dev/null | awk '{print $1}')

if [ -f "$ENV_FILE" ]; then
  TELEGRAM_BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
  TELEGRAM_CHAT_ID=$(grep -E '^TELEGRAM_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

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
    --data-urlencode "text=${text}" > /dev/null
}

case "${1:-monitor}" in
  monitor)
    USED=$(df / | awk 'NR==2 {gsub("%",""); print $5}')
    AVAIL=$(df -h / | awk 'NR==2 {print $4}')
    if [ "$USED" -ge "$ALERT_THRESHOLD" ]; then
      TOP=$(du -h -d 1 /var /home 2>/dev/null | sort -hr | head -5 | sed 's/^/  /')
      DOCKER=$(docker system df 2>/dev/null | tail -n +2 | sed 's/^/  /')
      MSG="<b>⚠️ VPS Disk Alert</b>
Host: <code>${HOSTNAME}</code> (${IP})
Disk used: <b>${USED}%</b> (free: ${AVAIL})

<b>Top dirs:</b>
<pre>${TOP}</pre>
<b>Docker:</b>
<pre>${DOCKER}</pre>"
      send_tg "$MSG"
      echo "[alert sent] disk ${USED}%"
    else
      echo "[ok] disk ${USED}%"
    fi
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
    find /var/log -name "*.gz" -mtime +14 -delete 2>/dev/null
    find /var/log -name "*.1" -mtime +14 -delete 2>/dev/null

    AFTER=$(df -h / | awk 'NR==2 {print $3" used, "$4" free ("$5")"}')
    MSG="<b>🧹 VPS Weekly Cleanup</b>
Host: <code>${HOSTNAME}</code> (${IP})

Before: ${BEFORE}
After:  ${AFTER}

<pre>${IMG}
${BUILD}</pre>"
    send_tg "$MSG"
    echo "[prune done] $AFTER"
    ;;

  test)
    send_tg "<b>✅ VPS Maintenance Test</b>
Host: <code>${HOSTNAME}</code> (${IP})
Time: $(date '+%Y-%m-%d %H:%M:%S %Z')

Telegram alerts wired correctly."
    echo "[test sent]"
    ;;

  *)
    echo "Usage: $0 {monitor|prune|test}"
    exit 1
    ;;
esac