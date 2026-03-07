FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 \
    jq \
    curl \
    ffmpeg \
    cron \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production

COPY src/ ./src/
COPY scripts/ ./scripts/
RUN chmod +x ./scripts/*.sh && sed -i 's/\r$//' ./scripts/*.sh

VOLUME /data
CMD ["node", "src/index.js"]
