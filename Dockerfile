# Build stage: compile TypeScript from source. CI builders (Glama) clone the
# repo fresh — dist/ is gitignored, so the image must build it itself.
FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src/ ./src/
RUN npm run build

# Runtime stage: production deps only. --ignore-scripts skips the local
# `prepare` script (which would run tsc without dev deps); ffmpeg-static's
# postinstall (downloads the ffmpeg binary) is then run explicitly via rebuild.
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild ffmpeg-static

COPY --from=build /app/dist/ ./dist/

ENTRYPOINT ["node", "dist/index.js"]
