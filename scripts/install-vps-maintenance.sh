#!/bin/bash
# Install VPS maintenance: copy script to /usr/local/bin and install cron jobs.
# CI/CD reruns this after deploy so cron and notification wiring stay current.
# Keep this script idempotent because deploy may refresh it on every push.
# Run on the VPS as root. Override ENV_FILE if your .env path differs.
#
#   sudo bash scripts/install-vps-maintenance.sh
#   sudo ENV_FILE=/path/to/.env bash scripts/install-vps-maintenance.sh

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash $0"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${ENV_FILE:-/home/ubuntu/Project/douyin-scraper/.env}"
PROJECT_NAME="${PROJECT_NAME:-douyin-scraper}"
PROJECT_DIR="${PROJECT_DIR:-/home/ubuntu/Project/douyin-scraper}"
COMPOSE_FILE="${COMPOSE_FILE:-${PROJECT_DIR}/docker-compose.yml}"
SUSPICIOUS_AUTH_THRESHOLD="${SUSPICIOUS_AUTH_THRESHOLD:-80}"
AUTH_ALERT_COOLDOWN_SECONDS="${AUTH_ALERT_COOLDOWN_SECONDS:-21600}"

install -m 0755 "$SCRIPT_DIR/vps-maintenance.sh" /usr/local/bin/vps-maintenance.sh
# Patch default ENV_FILE so manual runs work without exporting env var
sed -i "s|^ENV_FILE=\"\${ENV_FILE:-.*}\"|ENV_FILE=\"\${ENV_FILE:-${ENV_FILE}}\"|" /usr/local/bin/vps-maintenance.sh
sed -i "s|^PROJECT_NAME=\"\${PROJECT_NAME:-.*}\"|PROJECT_NAME=\"\${PROJECT_NAME:-${PROJECT_NAME}}\"|" /usr/local/bin/vps-maintenance.sh
sed -i "s|^PROJECT_DIR=\"\${PROJECT_DIR:-.*}\"|PROJECT_DIR=\"\${PROJECT_DIR:-${PROJECT_DIR}}\"|" /usr/local/bin/vps-maintenance.sh
sed -i "s|^COMPOSE_FILE=\"\${COMPOSE_FILE:-.*}\"|COMPOSE_FILE=\"\${COMPOSE_FILE:-${COMPOSE_FILE}}\"|" /usr/local/bin/vps-maintenance.sh
echo "Installed /usr/local/bin/vps-maintenance.sh (ENV_FILE=${ENV_FILE})"

install -m 0755 "$SCRIPT_DIR/douyin-session-check.sh" /usr/local/bin/douyin-session-check.sh
sed -i "s|^ENV_FILE=\"\${ENV_FILE:-.*}\"|ENV_FILE=\"\${ENV_FILE:-${ENV_FILE}}\"|" /usr/local/bin/douyin-session-check.sh
echo "Installed /usr/local/bin/douyin-session-check.sh"

cat > /etc/cron.d/vps-maintenance <<EOF
# VPS maintenance: ops monitor every 5m + daily summary + weekly docker cleanup
# + Douyin session health check daily. Times are Vietnam time via CRON_TZ.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CRON_TZ=Asia/Ho_Chi_Minh
ENV_FILE=${ENV_FILE}
PROJECT_NAME=${PROJECT_NAME}
PROJECT_DIR=${PROJECT_DIR}
COMPOSE_FILE=${COMPOSE_FILE}
SUSPICIOUS_AUTH_THRESHOLD=${SUSPICIOUS_AUTH_THRESHOLD}
AUTH_ALERT_COOLDOWN_SECONDS=${AUTH_ALERT_COOLDOWN_SECONDS}

*/5 * * * * root /usr/local/bin/vps-maintenance.sh monitor    >> /var/log/vps-maintenance.log 2>&1
30 8 * * *  root /usr/local/bin/vps-maintenance.sh summary    >> /var/log/vps-maintenance.log 2>&1
0 3 * * 0   root /usr/local/bin/vps-maintenance.sh prune      >> /var/log/vps-maintenance.log 2>&1
0 12 * * *  root /usr/local/bin/douyin-session-check.sh        >> /var/log/douyin-session-check.log 2>&1
EOF
chmod 644 /etc/cron.d/vps-maintenance
echo "Installed /etc/cron.d/vps-maintenance"

systemctl restart cron 2>/dev/null || systemctl restart crond 2>/dev/null || true

echo
echo "Done. Test now:"
echo "  /usr/local/bin/vps-maintenance.sh test"
echo "  /usr/local/bin/douyin-session-check.sh test    # Telegram test"
echo "  /usr/local/bin/douyin-session-check.sh          # real session check"
