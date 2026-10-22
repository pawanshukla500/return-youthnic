# syntax=docker/dockerfile:1
# Multi-stage production Dockerfile for Youthnic Return Scanning App

# ------------------------------------------------------------------------------
# Stage 1: Build Frontend and Verify Typecheck
# ------------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies if needed
RUN apk add --no-cache libc6-compat

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build & typecheck)
RUN npm ci

# Copy application source files
COPY tsconfig.json tsconfig.server.json tsconfig.desktop.json vite.config.ts index.html ./
COPY public/ ./public/
COPY src/ ./src/
COPY server/ ./server/
COPY desktop/ ./desktop/
COPY desktop-agent/ ./desktop-agent/

# Run static type checking and production Vite bundle build
RUN npm run typecheck
RUN npm run build

# ------------------------------------------------------------------------------
# Stage 2: Production Container
# ------------------------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

# Install curl for container healthcheck
RUN apk add --no-cache curl ca-certificates

# Environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV NODE_OPTIONS="--max-old-space-size=384"

# Copy dependency manifests and install production-only dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled frontend and server bundle from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server/dist.js ./server/dist.js

# Copy database schema definitions for runtime integrity check
COPY server/*.sql ./server/
COPY public/ ./public/

# Prepare persistent data and certificates directories
RUN mkdir -p /app/data /app/certs && \
    chown -R node:node /app

# Switch to non-root node user for security
USER node

# Expose backend API and frontend SPA port
EXPOSE 3001

# Healthcheck monitoring
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3001/api/health || exit 1

# Start production server directly with node for minimal RAM and zero tsx overhead
CMD ["node", "server/dist.js"]
