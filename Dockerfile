# Cloud Run video processor: Node + FFmpeg
FROM node:20-bookworm-slim

# Install FFmpeg (fluent-ffmpeg can use system ffmpeg; ffmpeg-static is still in node_modules as fallback)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
USER node
EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
