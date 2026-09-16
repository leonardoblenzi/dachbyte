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
ARG VOLT_CORE_PUBLIC_BASE_PATH=/business/core
ARG VOLT_CORE_API_BASE_PATH=/business/core/api
ENV VOLT_CORE_PUBLIC_BASE_PATH=${VOLT_CORE_PUBLIC_BASE_PATH} \
    VOLT_CORE_API_BASE_PATH=${VOLT_CORE_API_BASE_PATH} \
    VITE_VOLT_CORE_API_BASE=${VOLT_CORE_API_BASE_PATH}
ENV VOLT_CORE_APP_BASE_PATH=${VOLT_CORE_PUBLIC_BASE_PATH}/app
RUN npm --prefix apps/business/core ci --workspaces=false && npm --prefix apps/business/core run build
ENV NODE_ENV=production PORT=3000 DACHBYTE_PRODUCT=core
USER node
CMD ["node", "apps/business/product-server.cjs"]

FROM business-base AS stock
ARG VOLT_STOCK_PUBLIC_BASE_PATH=/business/stock
ARG VOLT_STOCK_PUBLIC_API_URL=/business/stock/api
ENV NEXT_PUBLIC_VOLTSTOCK_BASE_PATH=${VOLT_STOCK_PUBLIC_BASE_PATH} \
    NEXT_PUBLIC_API_URL=${VOLT_STOCK_PUBLIC_API_URL}
RUN npm --prefix apps/business/stock ci --include=dev \
 && npm --prefix apps/business/stock run build
RUN chown -R node:node apps/business/stock/apps/web/.next
ENV NODE_ENV=production PORT=3000 DACHBYTE_PRODUCT=stock
USER node
CMD ["node", "apps/business/product-server.cjs"]

FROM business-base AS chat
ARG VOLT_CHAT_PUBLIC_PATH=/business/chat
ARG VOLT_CHAT_PUBLIC_API_URL=/business/chat/api
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    VOLT_CHAT_PUBLIC_PATH=${VOLT_CHAT_PUBLIC_PATH} \
    VOLT_CHAT_PUBLIC_API_URL=${VOLT_CHAT_PUBLIC_API_URL}
RUN node apps/business/scripts/build-volt-chat.js
ENV NODE_ENV=production PORT=3000 DACHBYTE_PRODUCT=chat
USER node
CMD ["node", "apps/business/product-server.cjs"]

FROM business-base AS business
ENV NODE_ENV=production PORT=3000
USER node
CMD ["node", "apps/business/product-server.cjs"]
