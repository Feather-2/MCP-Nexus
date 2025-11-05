# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json package*.json ./
COPY src ./src
# GUI deps and sources
COPY gui/package*.json ./gui/
RUN npm ci --prefix gui
COPY gui ./gui
# Build backend
RUN npm run build
# Build GUI (outputs to /app/gui/dist per gui/vite.config.ts)
RUN npm run build --prefix gui

FROM node:20-alpine AS runner
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app

# Copy runtime files
COPY --from=build /app/dist ./dist
COPY --from=build /app/gui/dist ./gui/dist
COPY package*.json ./

# Install only production deps
RUN npm ci --omit=dev \
 && apk add --no-cache curl \
 && addgroup -g 1001 -S nodejs \
 && adduser -S nodejs -u 1001 -G nodejs \
 && mkdir -p /app/config/templates \
 && chown -R nodejs:nodejs /app

ENV PB_TEMPLATES_DIR=/app/config/templates

EXPOSE 19233

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -f http://127.0.0.1:19233/health || exit 1

USER nodejs

CMD ["node", "dist/index.js"]

