FROM node:24-bookworm AS opencli-build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build \
    && mkdir -p /out \
    && npm pack --ignore-scripts --pack-destination /out

FROM opencli-build AS opencli-extension-build
RUN npm ci --prefix extension --ignore-scripts \
    && npm run extension:build \
    && npm run package:release --prefix extension -- --out /out/extension

FROM node:24-bookworm-slim AS backend
COPY --from=opencli-build /out/*.tgz /tmp/opencli.tgz
RUN npm install --global /tmp/opencli.tgz \
    && rm /tmp/opencli.tgz \
    && opencli --version
WORKDIR /app
COPY services/opencli-backend/package.json services/opencli-backend/package-lock.json ./
RUN npm ci --omit=dev
COPY services/opencli-backend/src /app/src
COPY services/opencli-backend/scripts/smoke-deployment.mjs /app/scripts/smoke-deployment.mjs
ENV HOME=/home/node \
    OPENCLI_DATABASE_PATH=/data/jobs.sqlite3 \
    OPENCLI_API_HOST=0.0.0.0 \
    OPENCLI_API_PORT=8080
USER node
EXPOSE 8080
CMD ["node", "src/main.mjs"]

FROM lscr.io/linuxserver/chromium:3d7cd855-ls48 AS chromium
COPY --from=opencli-extension-build /out/extension/ /opt/opencli-extension/
