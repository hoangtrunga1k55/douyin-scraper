#!/bin/bash
# Douyin session health check -> Telegram alert when login expires.
#
# Hits GET /api/auth/status (checkSession) and alerts if logged_in != true,
# so you know exactly when to re-login instead of guessing the ~60-day window.
# Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from the project .env.
#
# Install + schedule: see scripts/install-vps-maintenance.sh
# Manual run:  douyin-session-check.sh        (check + alert if down)
#              douyin-session-check.sh test    (send a test Telegram message)

set -u

ENV_FILE="${ENV_FILE:-/home/ubuntu/Project/douyin-scraper/.env}"
STATUS_URL="${STATUS_URL:-http://127.0.0.1:3000/api/auth/status}"
LOGIN_URL_PUBLIC="${LOGIN_URL_PUBLIC:-https://thq-solution-tools.io.vn}"
STATE_FILE="${STATE_FILE:-/var/lib/douyin-session-check.state}"
HOSTNAME=$(hostname)

if [ -f "$ENV_FILE" ]; then
  TELEGRAM_BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
  TELEGRAM_CHAT_ID=$(grep -E '^TELEGRAM_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

send_tg() {
  local text="$1"
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "[skip telegram] missing creds"; return
  fi
  curl -s --max-time 10 \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "parse_mode=HTML" \
    --data-urlencode "text=${text}" > /dev/null
}

read_state() { [ -f "$STATE_FILE" ] && cat "$STATE_FILE" 2>/dev/null || echo "unknown"; }
write_state() { echo "$1" > "$STATE_FILE" 2>/dev/null || true; }

RELOGIN_STEPS="<b>Cách login lại:</b>
1) <code>curl ${LOGIN_URL_PUBLIC}/api/auth/login -H \"Authorization: Bearer TOKEN\"</code>
2) Mở <a href=\"${LOGIN_URL_PUBLIC}/douyin-login/vnc.html?path=douyin-login/websockify\">noVNC</a> → quét QR bằng app Douyin
3) <code>curl ${LOGIN_URL_PUBLIC}/api/auth/confirm -H \"Authorization: Bearer TOKEN\"</code>"

if [ "${1:-check}" = "test" ]; then
  send_tg "✅ <b>Douyin Session Check — Test</b>
Host: <code>${HOSTNAME}</code>
Endpoint: ${STATUS_URL}"
  echo "[test sent]"; exit 0
fi

# checkSession's logged_in detection is occasionally a false-negative (it parses
# RENDER_DATA right after domcontentloaded). So sample a few times and trust a
# single "true": if ANY sample is logged_in:true the session is valid. Only treat
# it as expired when no sample is true AND at least 2 valid samples say false.
SAMPLES="${SAMPLES:-3}"
true_n=0; false_n=0; valid_n=0
for i in $(seq 1 "$SAMPLES"); do
  RESP=$(curl -s --max-time 90 "$STATUS_URL" 2>/dev/null)
  if echo "$RESP" | grep -q '"logged_in":true'; then
    true_n=$((true_n + 1)); valid_n=$((valid_n + 1))
  elif echo "$RESP" | grep -q '"logged_in":false'; then
    false_n=$((false_n + 1)); valid_n=$((valid_n + 1))
  fi
  [ "$i" -lt "$SAMPLES" ] && sleep 15
done
echo "[samples] true=$true_n false=$false_n valid=$valid_n/$SAMPLES"

PREV=$(read_state)

if [ "$true_n" -ge 1 ]; then
  echo "[ok] douyin session logged_in (>=1 true)"
  if [ "$PREV" = "down" ]; then
    send_tg "✅ <b>Douyin session khôi phục</b>
Host: <code>${HOSTNAME}</code>
Đã đăng nhập lại thành công."
  fi
  write_state "ok"

elif [ "$false_n" -ge 2 ]; then
  echo "[alert] douyin session expired (no true, ${false_n} false)"
  send_tg "⚠️ <b>Douyin session HẾT HẠN</b>
Host: <code>${HOSTNAME}</code>
Feed sẽ trả data cũ / thiếu video mới cho tới khi login lại.

${RELOGIN_STEPS}"
  write_state "down"

else
  echo "[warn] inconclusive (valid=$valid_n) — API có thể không phản hồi"
  if [ "$valid_n" -eq 0 ]; then
    send_tg "🔌 <b>Douyin API không phản hồi</b>
Host: <code>${HOSTNAME}</code>
Không gọi được <code>${STATUS_URL}</code> — kiểm tra container <code>douyin-downloader</code>."
    write_state "unreachable"
  fi
fi