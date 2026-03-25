#!/bin/bash
set -e

echo "Starting X virtual framebuffer (Xvfb)..."
# Start Xvfb: target display :99, resolution 1280x800, 24-bit color
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99

echo "Starting Fluxbox (window manager)..."
fluxbox &

echo "Starting x11vnc..."
# Start VNC server (listening on localhost only to be proxied by websockify)
x11vnc -display :99 -forever -shared -bg -nopw -quiet -listen localhost -xkb

echo "Starting websockify (noVNC)..."
# Start websockify to expose VNC over WebSockets on port 6080
/usr/share/novnc/utils/novnc_proxy --listen 6080 --vnc localhost:5900 &

echo "Cleaning up Chromium locks..."
rm -f /app/.browser_data/SingletonLock
rm -f /app/.browser_data/SingletonCookie

echo "Starting Node.js Application..."
exec npm run start
