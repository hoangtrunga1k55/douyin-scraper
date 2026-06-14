#!/bin/bash
# Deploy douyin-scraper on the VPS: build -> restart -> prune old images -> health-check -> Telegram notify.
#
# Invoked by .github/workflows/deploy.yml AFTER it has git-updated the repo
# (the workflow does `git fetch && git reset --hard origin/master` first).
#
# Manual run on the VPS:
#   cd /home/ubuntu/Project/douyin-scraper && bash scripts/deploy.sh
#
# The image-prune step below is the CI counterpart to scripts/vps-maintenance.sh:
# stacked old `douyin-scraper-*` images + BuildKit cache were the #1 disk hog in
# the 2026-05-29 disk-full incident, so every deploy cleans them up immediately.

set -uo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/ubuntu/Project/douyin-scraper}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/api/health}"
SERVICE="douyin-api"

cd "$PROJECT_DIR" || { echo "✗ Cannot cd into $PROJECT_DIR"; exit 1; }

# ── Telegram helper (reads creds from project .env, same as vps-maintenance.sh) ──
if [ -f "$ENV_FILE" ]; then
  TELEGRAM_BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
  TELEGRAM_CHAT_ID=$(grep -E '^TELEGRAM_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
fi
send_tg() {
  [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ] && return 0
  curl -s --max-time 10 \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "parse_mode=HTML" \
    --data-urlencode "text=$1" > /dev/null
}

COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
SUBJECT=$(git log -1 --pretty=%s 2>/dev/null || echo "")

echo "▶ Building $SERVICE ($COMMIT: $SUBJECT)..."
if ! docker compose build "$SERVICE"; then
  send_tg "❌ <b>Deploy FAILED</b> (build error)
<code>${COMMIT}</code> ${SUBJECT}"
  exit 1
fi

echo "▶ Recreating containers..."
docker compose up -d

# ── Cleanup: prevent the disk-full failure mode from the 2026-05-29 incident ──
echo "▶ Pruning docker images + build cache older than 7 days..."
docker image prune -af --filter "until=168h" || true
docker builder prune -af --filter "unused-for=168h" || true

# ── Health check (retry ~60s while Xvfb + Chromium boot inside the container) ──
echo "▶ Health check ($HEALTH_URL)..."
OK=0
for i in $(seq 1 12); do
  if curl -fsS --max-time 5 "$HEALTH_URL" > /dev/null 2>&1; then OK=1; break; fi
  sleep 5
done

DISK=$(df -h / | awk 'NR==2 {print $5" used, "$4" free"}')

if [ "$OK" = "1" ]; then
  send_tg "✅ <b>Deploy OK</b>
<code>${COMMIT}</code> ${SUBJECT}
Disk: ${DISK}"
  echo "✅ Deploy OK ($COMMIT). Disk: $DISK"
else
  echo "⚠️ Health check failed — last 50 log lines:"
  docker compose logs --tail=50 "$SERVICE" || true
  send_tg "⚠️ <b>Deploy: containers up but HEALTH CHECK FAILED</b>
<code>${COMMIT}</code> ${SUBJECT}
Disk: ${DISK}
Check: docker compose logs $SERVICE"
  exit 1
fi