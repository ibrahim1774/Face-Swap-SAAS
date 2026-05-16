# Long-form video editor worker.
#
# Node 20 + FFmpeg 6 + bundled fonts. Single image used by Fly for the
# polling worker. Build-time `npm ci`; runtime `node index.js`.

FROM node:20-bookworm-slim AS base

# FFmpeg + minimum fonts. fontconfig is required so libass can resolve
# bundled fonts inside /usr/share/fonts at render time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Bundle fonts inside the image — never load at runtime.
# Add fonts to ./fonts/ in this directory before building.
COPY fonts/ /usr/share/fonts/haelabs/
RUN fc-cache -fv

WORKDIR /app

# Install deps separately to leverage Docker layer cache.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Worker source.
COPY . .

# Fly needs a HEALTHCHECK target; the worker has no HTTP server, so we
# rely on Fly's process supervision for liveness. NODE_ENV=production
# for the Supabase client.
ENV NODE_ENV=production

CMD ["node", "index.js"]
