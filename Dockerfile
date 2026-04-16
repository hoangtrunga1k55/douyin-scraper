FROM node:20-slim

# Install Chromium + fonts + Xvfb + VNC (noVNC web interface on port 6080)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       chromium \
       fonts-noto-cjk \
       fonts-noto-color-emoji \
       ca-certificates \
       curl \
       xvfb \
       x11vnc \
       novnc \
       fluxbox \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /var/cache/apt/archives/*

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
RUN mkdir -p downloads .browser_data .browser_data_tiktok logs

# Expose Node app port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Start using the custom script that initializes Xvfb
CMD ["./start.sh"]
