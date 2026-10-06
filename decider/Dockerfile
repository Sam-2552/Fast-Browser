FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./
USER node

EXPOSE 9300
ENV PORT=9300

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s \
  CMD wget -qO- http://localhost:9300/health || exit 1

CMD ["node", "server.mjs"]
