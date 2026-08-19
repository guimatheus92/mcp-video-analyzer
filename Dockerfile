# Build stage: compile TypeScript from source. CI builders (Glama) clone the
# repo fresh — dist/ is gitignored, so the image must build it itself.
FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src/ ./src/
RUN npm run build

# Runtime stage: production deps only. --ignore-scripts skips the local
# `prepare` script (which would run tsc without dev deps); ffmpeg-static's
# postinstall (downloads the ffmpeg binary) is then run explicitly via rebuild.
#
# sharp needs nothing here. Since 0.35 it has no install script at all, and its
# prebuilt @img/* optionalDependencies declare no scripts either, so the libvips
# binary comes straight out of the lockfile. (Pre-0.35 its install script was
# ALREADY being skipped by --ignore-scripts in this image and sharp worked
# anyway -- that is the proof the prebuilts do 100% of the work.) The e2e/docker
# CI jobs assert the binary actually loads; see ci.yml.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild ffmpeg-static

COPY --from=build /app/dist/ ./dist/

# The tessdata cache and the CLI's default --out resolve to the per-user cache
# dir (persistentCacheDir), i.e. /root/.cache here. That is NOT writable under
# the standard MCP hardening recipe `docker run --read-only --tmpfs /tmp`,
# which would silently cost every OCR result and every emitted frame. Pin the
# cache at the one path that recipe leaves writable. A fixed name under /tmp is
# safe here in a way it is not on a shared host: the container is single-uid by
# construction, and this is an explicit image decision rather than a default.
ENV MCP_CACHE_DIR=/tmp/mcp-video-analyzer-cache

ENTRYPOINT ["node", "dist/index.js"]
