#!/bin/bash
# Install VPS maintenance: copy script to /usr/local/bin and install cron jobs.
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

install -m 0755 "$SCRIPT_DIR/vps-maintenance.sh" /usr/local/bin/vps-maintenance.sh
echo "Installed /usr/local/bin/vps-maintenance.sh"

cat > /etc/cron.d/vps-maintenance <<EOF
# VPS maintenance: disk monitor (hourly) + docker prune (weekly Sun 03:00)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV_FILE=${ENV_FILE}

0 * * * * root /usr/local/bin/vps-maintenance.sh monitor >> /var/log/vps-maintenance.log 2>&1
0 3 * * 0 root /usr/local/bin/vps-maintenance.sh prune   >> /var/log/vps-maintenance.log 2>&1
EOF
chmod 644 /etc/cron.d/vps-maintenance
echo "Installed /etc/cron.d/vps-maintenance"

systemctl restart cron 2>/dev/null || systemctl restart crond 2>/dev/null || true

echo
echo "Done. Test now:"
echo "  /usr/local/bin/vps-maintenance.sh test"