# Build context is the bofa-poc directory (see docker-compose.yml): the builder source lives in ./builder
FROM node:22-slim

# no calls to external services from the bank environment
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

COPY builder/package.json builder/yarn.lock ./
RUN npm install --legacy-peer-deps --no-audit --no-fund

COPY builder/ .
RUN npx next build

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production
# editor UI (3000, internal), proxy (8080)
EXPOSE 3000 8080

ENTRYPOINT ["entrypoint.sh"]
