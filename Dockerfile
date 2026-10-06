FROM node:22-alpine

RUN apk add --no-cache \
    chromium nss freetype harfbuzz ca-certificates ttf-freefont \
  && rm -rf /var/cache/apk/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROME_BIN=/usr/bin/chromium-browser

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./

RUN mkdir -p /data/profile
VOLUME /data/profile

EXPOSE 9222
ENV PORT=9222

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:9222/health || exit 1

CMD ["node", "server.mjs"]
