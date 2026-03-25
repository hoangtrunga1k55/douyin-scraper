FROM node:20-slim

# Install Chromium + Vietnamese fonts + utilities + GUI dependencies (Xvfb, VNC, noVNC)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    ca-certificates \
    curl \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer to use installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
# Set default DISPLAY for the virtual framebuffer
ENV DISPLAY=:99

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source code and start script
COPY . .

# Ensure start script is executable (in case it wasn't on host)
RUN chmod +x start.sh

# Create directories
RUN mkdir -p downloads .browser_data logs

# Expose Node app port and noVNC port
EXPOSE 3000 6080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Start using the custom script that initializes Xvfb and VNC
CMD ["./start.sh"]
