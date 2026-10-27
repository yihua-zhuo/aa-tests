# syntax=docker/dockerfile:1

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/pulse.db \
    DEMO_MODE=0
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/web/dist ./web/dist

RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.ts"]
