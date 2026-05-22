FROM node:22-slim

# Install system Chromium for Playwright fallback
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Point the app at the system-installed Chromium
ENV CHROME_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Cache is stored in src/data/ — mount this as a named volume so it
# survives container restarts and image updates.
VOLUME ["/app/src/data"]

EXPOSE 3000
CMD ["node", "src/server.js"]
