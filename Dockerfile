# For reproducible builds, pin to a digest. To get the current digest:
#   docker pull node:20-alpine && docker inspect node:20-alpine \
#     --format '{{ index .RepoDigests 0 }}'
# Then replace the line below with: FROM node:20-alpine@sha256:<digest>
FROM node:20-alpine

WORKDIR /app

# Single npm dependency: web-push (RFC 8291 push encryption + VAPID).
# Installed first so its layer is cached when application code changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.js data.js ./

# Static frontend lives in public/
RUN mkdir -p public
COPY index.html styles.css app.js data.js alpine.min.js sw.js ./public/
COPY manifest.webmanifest og.png favicon.svg apple-touch-icon.png ./public/

# Persistent volume for results / schedule
RUN mkdir -p /data
VOLUME ["/data"]

ENV PORT=3000
ENV DATA_DIR=/data
# Server-side date logic ("is this match scheduled for TODAY?") must use the
# tournament's local timezone, not UTC. Without this, a Bulgarian admin
# scheduling a match for 19:00 Sofia time would have the non-admin scoring
# endpoint reject the result after ~21:00 UTC because the server thinks the
# date already rolled over.
ENV TZ=Europe/Sofia
# ADMIN_PASSWORD MUST be set at runtime via Coolify env vars

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
