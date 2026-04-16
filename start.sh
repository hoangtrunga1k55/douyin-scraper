#!/bin/bash
set -e

echo "Starting X virtual framebuffer (Xvfb)..."
# Clean up stale lock files from previous runs
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
# Start Xvfb: target display :99, resolution 1280x800, 24-bit color
Xvfb :99 -screen 0 1280x800x24 &
sleep 1
export DISPLAY=:99

# Start window manager + VNC + noVNC web interface
if command -v fluxbox &> /dev/null; then
  echo "Starting Fluxbox (window manager)..."
  fluxbox &
  sleep 1
fi
if command -v x11vnc &> /dev/null; then
  echo "Starting x11vnc on :5900..."
  x11vnc -display :99 -forever -shared -nopw -quiet -xkb -bg
  sleep 1
fi
# noVNC proxy: try both possible install paths
NOVNC_PROXY=""
for p in /usr/share/novnc/utils/novnc_proxy /usr/share/novnc/utils/launch.sh /usr/bin/novnc_proxy; do
  [ -f "$p" ] && NOVNC_PROXY="$p" && break
done
if [ -n "$NOVNC_PROXY" ]; then
  echo "Starting noVNC on port 6080..."
  "$NOVNC_PROXY" --listen 6080 --vnc localhost:5900 &
else
  echo "noVNC not found, trying websockify directly..."
  if command -v websockify &> /dev/null; then
    websockify --web /usr/share/novnc 6080 localhost:5900 &
  fi
fi

echo "Cleaning up Chromium locks..."
rm -f /app/.browser_data/SingletonLock
rm -f /app/.browser_data/SingletonCookie
rm -f /app/.browser_data_tiktok/SingletonLock
rm -f /app/.browser_data_tiktok/SingletonCookie

echo "Starting Node.js Application..."
exec npm run start
