FROM node:20-bookworm-slim

# Install system deps for Playwright + Xvfb (virtual display for headed Chrome)
RUN apt-get update && apt-get install -y \
    wget ca-certificates xvfb \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies first (layer caching)
COPY package*.json ./
RUN npm ci --only=production

# Install Playwright's bundled Chromium with all its deps
RUN npx playwright install chromium --with-deps

# Copy app source
COPY . .

# Persistent data directory (mount a Railway volume here)
RUN mkdir -p /data/browser-data

ENV BROWSER_DATA_DIR=/data/browser-data
ENV DB_PATH=/data/messageai.db
ENV NODE_ENV=production
ENV PORT=3000
ENV DISPLAY=:99

EXPOSE 3000

# Start Xvfb virtual display, then launch the app in headed mode.
# Headed Chrome on Xvfb is indistinguishable from a real browser to Cloudflare.
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset & sleep 2 && DOORDASH_HEADLESS=false node server.js"]
