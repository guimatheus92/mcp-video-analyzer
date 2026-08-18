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

ENTRYPOINT ["node", "dist/index.js"]
