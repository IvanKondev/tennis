FROM node:20-alpine

WORKDIR /app

# No npm dependencies — server uses only Node built-ins
COPY server.js data.js ./

# Static frontend lives in public/
RUN mkdir -p public
COPY index.html styles.css app.js data.js alpine.min.js ./public/

# Persistent volume for results / schedule
RUN mkdir -p /data
VOLUME ["/data"]

ENV PORT=3000
ENV DATA_DIR=/data
# ADMIN_PASSWORD MUST be set at runtime via Coolify env vars

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
