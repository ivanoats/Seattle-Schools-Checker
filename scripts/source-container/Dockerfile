FROM node:24-bookworm-slim

WORKDIR /probe
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --silent --show-error --location \
       https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
       --output /tmp/google-chrome.deb \
    && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
    && rm /tmp/google-chrome.deb \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src/auth.js src/
COPY scripts/browser-run/source-probe.js scripts/browser-run/portal-start.js scripts/browser-run/
COPY scripts/source-container/server.js scripts/source-container/

USER node
EXPOSE 8080
CMD ["node", "scripts/source-container/server.js"]
