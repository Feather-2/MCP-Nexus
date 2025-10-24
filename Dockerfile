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
# Build backend
RUN npm run build

FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# Copy runtime files
COPY --from=build /app/dist ./dist
COPY package*.json ./

# Install only production deps
RUN npm ci --omit=dev

# Prepare config directories inside container
RUN mkdir -p /app/config/templates
ENV PB_TEMPLATES_DIR=/app/config/templates

EXPOSE 19233

CMD ["node", "dist/index.js"]

