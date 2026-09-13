FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node . .
RUN npm ci --include=dev

FROM base AS seller
RUN npm --prefix apps/seller-madeira ci --workspaces=false \
 && npm --prefix apps/seller-tracking ci \
 && npm --prefix apps/seller-tracking/server ci \
 && cd apps/seller-tracking/server && npx tsc \
 && cd /app && npm --prefix apps/seller-tracking run build
RUN mkdir -p apps/seller-ml/results && chown node:node apps/seller-ml/results
ENV NODE_ENV=production PORT=3000
USER node
CMD ["node", "apps/gateway/server.js"]

FROM base AS business-base
RUN npm --prefix apps/business ci --ignore-scripts --workspaces=false

FROM business-base AS core
RUN npm --prefix apps/business/core ci --workspaces=false && npm --prefix apps/business/core run build
ENV NODE_ENV=production PORT=3000 DACHBYTE_PRODUCT=core
USER node
CMD ["node", "apps/business/product-server.cjs"]

FROM business-base AS stock
RUN npm --prefix apps/business/stock ci --include=dev \
 && npm --prefix apps/business/stock run build
RUN chown -R node:node apps/business/stock/apps/web/.next
ENV NODE_ENV=production PORT=3000 DACHBYTE_PRODUCT=stock
USER node
CMD ["node", "apps/business/product-server.cjs"]

FROM business-base AS chat
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN node apps/business/scripts/build-volt-chat.js
ENV NODE_ENV=production PORT=3000 DACHBYTE_PRODUCT=chat
USER node
CMD ["node", "apps/business/product-server.cjs"]

FROM business-base AS business
ENV NODE_ENV=production PORT=3000
USER node
CMD ["node", "apps/business/product-server.cjs"]
