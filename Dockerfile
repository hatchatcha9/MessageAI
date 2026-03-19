FROM node:20-bookworm-slim

# Install system deps for Playwright
RUN apt-get update && apt-get install -y \
    wget ca-certificates \
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

ENV DOORDASH_HEADLESS=true
ENV BROWSER_DATA_DIR=/data/browser-data
ENV DB_PATH=/data/messageai.db
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
