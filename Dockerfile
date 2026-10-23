# The hosted rt-draw app (imagine.emberhub.dev): the page built from app/ and its API
# (app/server/host.ts) on one port. Built and shipped by scripts/deploy.sh.
FROM node:22.21.1-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci
COPY app/package.json app/package-lock.json app/
RUN npm ci --prefix app
# What the page is built from: the app, v2's engine, and what the app's Vite config and timing import.
COPY src src
COPY dev dev
COPY playgrounds/speech/token-plugin.ts playgrounds/speech/
COPY evals/bridge/timing.ts evals/bridge/
COPY app app
RUN cd app && npx vite build

FROM node:22.21.1-slim
WORKDIR /repo
ENV NODE_ENV=production PORT=8200 RT_DATA_DIR=/data
# The API's plugins read their keys with Vite's loadEnv, so Vite stays (and the Agent SDK runs Claude Code).
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force
COPY dev dev
COPY playgrounds/speech/token-plugin.ts playgrounds/speech/
COPY app/package.json app/
COPY app/server app/server
COPY --from=build /repo/app/dist app/dist
# The subscription's Claude Code processes keep their state under HOME and /data/claude-config.
RUN rm -f app/server/*.test.ts && chmod -R a+rX /repo && mkdir -p /data && chown node:node /data
USER node
EXPOSE 8200
CMD ["node", "app/server/main.ts"]
