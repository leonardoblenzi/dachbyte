-- CreateEnum
CREATE TYPE "MadEnvironment" AS ENUM ('sandbox', 'production');

-- CreateEnum
CREATE TYPE "MadIntegrationStatus" AS ENUM ('draft', 'active', 'paused', 'error', 'archived');

-- CreateEnum
CREATE TYPE "MadSyncDomain" AS ENUM ('catalog', 'inventory', 'price', 'orders', 'freight', 'finance', 'messaging', 'callbacks');

-- CreateEnum
CREATE TYPE "MadSyncStatus" AS ENUM ('pending', 'running', 'success', 'partial', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "MadPublicationStatus" AS ENUM ('draft', 'queued', 'validating', 'published', 'paused', 'failed', 'archived');

-- CreateEnum
CREATE TYPE "MadOrderStatus" AS ENUM ('imported', 'awaiting_invoice', 'ready_to_ship', 'shipped', 'delivered', 'cancelled', 'returned', 'refunded', 'on_hold');

-- CreateEnum
CREATE TYPE "MadFreightMode" AS ENUM ('table', 'callback', 'contingency');

-- CreateEnum
CREATE TYPE "MadFreightStatus" AS ENUM ('pending', 'quoted', 'accepted', 'rejected', 'expired', 'failed');

-- CreateEnum
CREATE TYPE "MadFinancialStatus" AS ENUM ('pending', 'released', 'paid', 'blocked', 'disputed', 'cancelled');

-- CreateEnum
CREATE TYPE "MadThreadStatus" AS ENUM ('open', 'waiting_seller', 'waiting_marketplace', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "MadMessageDirection" AS ENUM ('incoming', 'outgoing', 'system');

-- CreateEnum
CREATE TYPE "MadMessageStatus" AS ENUM ('unread', 'pending', 'sent', 'delivered', 'failed', 'resolved');

-- CreateEnum
CREATE TYPE "MadWebhookStatus" AS ENUM ('received', 'processing', 'processed', 'failed', 'ignored');

-- CreateTable
CREATE TABLE "MadWorkspace" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sellerName" TEXT NOT NULL,
    "sellerCode" TEXT,
    "environment" "MadEnvironment" NOT NULL DEFAULT 'production',
    "status" "MadIntegrationStatus" NOT NULL DEFAULT 'draft',
    "apiBaseUrl" TEXT,
    "messagingBaseUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MadCategory" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "parentExternalId" TEXT,
    "name" TEXT NOT NULL,
    "path" TEXT,
    "isLeaf" BOOLEAN NOT NULL DEFAULT false,
    "attributesSchema" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MadProduct" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "categoryId" TEXT,
    "externalId" TEXT,
    "sku" TEXT NOT NULL,
    "ean" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "MadPublicationStatus" NOT NULL DEFAULT 'draft',
    "currentPrice" DECIMAL(12,2) NOT NULL,
    "compareAtPrice" DECIMAL(12,2),
    "stock" INTEGER NOT NULL DEFAULT 0,
    "weightGrams" INTEGER,
    "heightCm" INTEGER,
    "widthCm" INTEGER,
    "lengthCm" INTEGER,
    "payload" JSONB,
    "marketplacePayload" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MadProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "altText" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MadProductAttribute" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "externalAttributeId" TEXT,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "unit" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadProductAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MadSyncRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "domain" "MadSyncDomain" NOT NULL,
    "status" "MadSyncStatus" NOT NULL DEFAULT 'pending',
    "requestedBy" TEXT,
    "itemsTotal" INTEGER NOT NULL DEFAULT 0,
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "itemsFailed" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MadOrder" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalCode" TEXT,
    "status" "MadOrderStatus" NOT NULL DEFAULT 'imported',
    "buyerName" TEXT,
    "buyerDocument" TEXT,
    "buyerEmail" TEXT,
    "shippingMethod" TEXT,
    "freightMode" "MadFreightMode",
    "subtotalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "freightAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "rawPayload" JSONB,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MadOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL DEFAULT 0,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MadFreightQuote" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "orderId" TEXT,
    "externalRequestId" TEXT,
    "mode" "MadFreightMode" NOT NULL DEFAULT 'callback',
    "status" "MadFreightStatus" NOT NULL DEFAULT 'pending',
    "destinationZip" TEXT NOT NULL,
    "serviceName" TEXT,
    "carrierName" TEXT,
    "quotedAmount" DECIMAL(12,2),
    "deliveryDays" INTEGER,
    "responseTimeMs" INTEGER,
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadFreightQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MadFinancialEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "orderId" TEXT,
    "externalId" TEXT,
    "type" TEXT NOT NULL,
    "status" "MadFinancialStatus" NOT NULL DEFAULT 'pending',
    "description" TEXT,
    "grossAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "feeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "releaseDate" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadFinancialEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MadMessageThread" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "orderId" TEXT,
    "externalThreadId" TEXT,
    "counterpartName" TEXT,
    "status" "MadThreadStatus" NOT NULL DEFAULT 'open',
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadMessageThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MadMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "externalId" TEXT,
    "direction" "MadMessageDirection" NOT NULL,
    "status" "MadMessageStatus" NOT NULL DEFAULT 'pending',
    "authorName" TEXT,
    "content" TEXT NOT NULL,
    "attachmentUrl" TEXT,
    "sentAt" TIMESTAMP(3),
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MadWebhookEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "externalEventId" TEXT,
    "status" "MadWebhookStatus" NOT NULL DEFAULT 'received',
    "sourceIp" TEXT,
    "headers" JSONB,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MadWorkspace_slug_key" ON "MadWorkspace"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "MadWorkspace_sellerCode_key" ON "MadWorkspace"("sellerCode");

-- CreateIndex
CREATE UNIQUE INDEX "MadCategory_externalId_key" ON "MadCategory"("externalId");

-- CreateIndex
CREATE INDEX "MadCategory_parentExternalId_idx" ON "MadCategory"("parentExternalId");

-- CreateIndex
CREATE INDEX "MadProduct_workspaceId_status_idx" ON "MadProduct"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "MadProduct_categoryId_idx" ON "MadProduct"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "MadProduct_workspaceId_sku_key" ON "MadProduct"("workspaceId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "MadProduct_workspaceId_externalId_key" ON "MadProduct"("workspaceId", "externalId");

-- CreateIndex
CREATE INDEX "MadProductImage_productId_position_idx" ON "MadProductImage"("productId", "position");

-- CreateIndex
CREATE INDEX "MadProductAttribute_productId_idx" ON "MadProductAttribute"("productId");

-- CreateIndex
CREATE INDEX "MadSyncRun_workspaceId_domain_status_idx" ON "MadSyncRun"("workspaceId", "domain", "status");

-- CreateIndex
CREATE INDEX "MadSyncRun_startedAt_idx" ON "MadSyncRun"("startedAt");

-- CreateIndex
CREATE INDEX "MadOrder_workspaceId_status_idx" ON "MadOrder"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MadOrder_workspaceId_externalId_key" ON "MadOrder"("workspaceId", "externalId");

-- CreateIndex
CREATE INDEX "MadOrderItem_sku_idx" ON "MadOrderItem"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "MadOrderItem_orderId_lineNumber_key" ON "MadOrderItem"("orderId", "lineNumber");

-- CreateIndex
CREATE INDEX "MadFreightQuote_workspaceId_status_idx" ON "MadFreightQuote"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "MadFreightQuote_orderId_idx" ON "MadFreightQuote"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "MadFreightQuote_workspaceId_externalRequestId_key" ON "MadFreightQuote"("workspaceId", "externalRequestId");

-- CreateIndex
CREATE INDEX "MadFinancialEntry_workspaceId_status_idx" ON "MadFinancialEntry"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "MadFinancialEntry_orderId_idx" ON "MadFinancialEntry"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "MadFinancialEntry_workspaceId_externalId_key" ON "MadFinancialEntry"("workspaceId", "externalId");

-- CreateIndex
CREATE INDEX "MadMessageThread_workspaceId_status_idx" ON "MadMessageThread"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "MadMessageThread_orderId_idx" ON "MadMessageThread"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "MadMessageThread_workspaceId_externalThreadId_key" ON "MadMessageThread"("workspaceId", "externalThreadId");

-- CreateIndex
CREATE INDEX "MadMessage_threadId_status_idx" ON "MadMessage"("threadId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MadMessage_threadId_externalId_key" ON "MadMessage"("threadId", "externalId");

-- CreateIndex
CREATE INDEX "MadWebhookEvent_workspaceId_topic_status_idx" ON "MadWebhookEvent"("workspaceId", "topic", "status");

-- CreateIndex
CREATE INDEX "MadWebhookEvent_receivedAt_idx" ON "MadWebhookEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MadWebhookEvent_workspaceId_externalEventId_key" ON "MadWebhookEvent"("workspaceId", "externalEventId");

-- AddForeignKey
ALTER TABLE "MadProduct" ADD CONSTRAINT "MadProduct_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "MadWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadProduct" ADD CONSTRAINT "MadProduct_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MadCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadProductImage" ADD CONSTRAINT "MadProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "MadProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadProductAttribute" ADD CONSTRAINT "MadProductAttribute_productId_fkey" FOREIGN KEY ("productId") REFERENCES "MadProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadSyncRun" ADD CONSTRAINT "MadSyncRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "MadWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadOrder" ADD CONSTRAINT "MadOrder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "MadWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadOrderItem" ADD CONSTRAINT "MadOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MadOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadFreightQuote" ADD CONSTRAINT "MadFreightQuote_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "MadWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadFreightQuote" ADD CONSTRAINT "MadFreightQuote_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MadOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadFinancialEntry" ADD CONSTRAINT "MadFinancialEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "MadWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadFinancialEntry" ADD CONSTRAINT "MadFinancialEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MadOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadMessageThread" ADD CONSTRAINT "MadMessageThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "MadWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadMessageThread" ADD CONSTRAINT "MadMessageThread_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MadOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadMessage" ADD CONSTRAINT "MadMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MadMessageThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MadWebhookEvent" ADD CONSTRAINT "MadWebhookEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "MadWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
