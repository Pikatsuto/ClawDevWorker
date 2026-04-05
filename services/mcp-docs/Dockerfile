FROM node:24-alpine AS build

WORKDIR /build
COPY tsconfig.json package.json package-lock.json ./
COPY shared/opt/mcp-docs/ shared/opt/mcp-docs/
RUN npm ci && npx tsc

FROM node:24-alpine

WORKDIR /app
COPY shared/opt/mcp-docs/package.json .
RUN npm install --omit=dev 2>/dev/null || true

COPY --from=build /build/dist/shared/opt/mcp-docs/src/ src/
COPY shared/opt/mcp-docs/scripts/ scripts/

ENV NODE_ENV=production
ENV DEVDOCS_URL=http://devdocs:9292
ENV SEARXNG_URL=http://searxng:8080
ENV NODRIVER_URL=http://browserless:3000
ENV MAX_RESULTS=5
ENV FETCH_TIMEOUT=8000

CMD ["node", "src/index.js"]
