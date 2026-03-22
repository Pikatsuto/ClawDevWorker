FROM node:20-alpine

WORKDIR /app

COPY services/mcp-docs/package.json .
# Pas de dépendances externes — stdlib Node.js uniquement
RUN npm install --omit=dev 2>/dev/null || true

COPY services/mcp-docs/src/ src/

ENV NODE_ENV=production
ENV DEVDOCS_URL=http://devdocs:9292
ENV SEARXNG_URL=http://searxng:8080
ENV NODRIVER_URL=http://browserless:3000
ENV MAX_RESULTS=5
ENV FETCH_TIMEOUT=8000

CMD ["node", "src/index.js"]
