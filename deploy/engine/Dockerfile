# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Return App — headless Marketplace Claims Automation Engine
#
# Runs the claim automation engine on a Linux server with no graphical desktop:
# queue polling, CDP browser automation against the supplier portals, panel
# state, health probe and the bearer-token control API.
#
# Chromium is installed from the distro (not bundled) and driven headless via
# the Chrome DevTools Protocol, which is the same code path the Windows build
# uses against the system browser.
# ---------------------------------------------------------------------------

FROM node:22-slim

ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive \
    AGENT_DATA_DIR=/var/lib/return-app-engine \
    ENGINE_HOST=0.0.0.0 \
    ENGINE_PORT=3005 \
    BROWSER_MODE=headless \
    BROWSER_PATH=/usr/bin/chromium \
    HEADLESS=true

# Chromium plus the fonts and shared libraries it needs headless on slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        curl \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libx11-6 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so the layer caches when only source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Engine sources only. The web client, Android client and desktop shell are not
# part of this image.
COPY desktop-agent ./desktop-agent

# The engine writes profiles, evidence cache and logs here; mount a volume.
RUN mkdir -p /var/lib/return-app-engine \
    && chown -R node:node /var/lib/return-app-engine /app

USER node

EXPOSE 3005

# Liveness: the health probe is the only route that does not need the token.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${ENGINE_PORT}/api/health" || exit 1

# tini reaps the Chromium child processes so no zombie browsers survive a claim.
ENTRYPOINT ["/usr/bin/tini", "--"]
# The heap cap matches the desktop shell and AGENTS.md rule 13: the engine must
# stay inside 256 MB of V8 heap so a container on 4 GB / 2-core hardware cannot
# be OOM-killed mid-claim. Without it Node sizes the heap from the host's total
# RAM, which is far larger than the engine is allowed to use.
CMD ["node", "--max-old-space-size=256", "--import", "tsx", "desktop-agent/src/desktop-app-server.ts", "--no-window"]
