BEGIN;

CREATE TABLE IF NOT EXISTS "GiftCampaign" (
  id UUID NOT NULL,
  "shopId" INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  "minSpendCents" INTEGER NOT NULL DEFAULT 0,
  "targetMarginRate" NUMERIC(12, 8) NULL,
  "startAt" TIMESTAMP(3) NULL,
  "endAt" TIMESTAMP(3) NULL,
  "useMaxDuration" BOOLEAN NOT NULL DEFAULT false,
  "conflictPolicy" TEXT NULL,
  "logisticsResolution" TEXT NULL,
  "logisticsPlan" JSONB NOT NULL DEFAULT '{}'::jsonb,
  preview JSONB NOT NULL DEFAULT '{}'::jsonb,
  "remoteAddOnDealId" BIGINT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdByUserId" INTEGER NULL,
  "updatedByUserId" INTEGER NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GiftCampaign_pkey" PRIMARY KEY (id),
  CONSTRAINT "GiftCampaign_id_shopId_key" UNIQUE (id, "shopId"),
  CONSTRAINT "GiftCampaign_idempotencyKey_key" UNIQUE ("shopId", "idempotencyKey"),
  CONSTRAINT "GiftCampaign_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "GiftCampaignMainItem" (
  id BIGSERIAL NOT NULL,
  "campaignId" UUID NOT NULL,
  "shopId" INTEGER NOT NULL,
  "pricingKey" TEXT NOT NULL,
  "productId" INTEGER NULL,
  "itemId" BIGINT NULL,
  "modelId" BIGINT NULL,
  title TEXT NULL,
  sku TEXT NULL,
  "priceCents" INTEGER NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GiftCampaignMainItem_pkey" PRIMARY KEY (id),
  CONSTRAINT "GiftCampaignMainItem_campaignId_shopId_fkey" FOREIGN KEY ("campaignId", "shopId") REFERENCES "GiftCampaign"(id, "shopId") ON DELETE CASCADE,
  CONSTRAINT "GiftCampaignMainItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"(id) ON DELETE CASCADE,
  CONSTRAINT "GiftCampaignMainItem_campaignId_pricingKey_key" UNIQUE ("campaignId", "pricingKey")
);

CREATE TABLE IF NOT EXISTS "GiftCampaignGiftItem" (
  id BIGSERIAL NOT NULL,
  "campaignId" UUID NOT NULL,
  "shopId" INTEGER NOT NULL,
  "pricingKey" TEXT NOT NULL,
  "productId" INTEGER NULL,
  "itemId" BIGINT NULL,
  "modelId" BIGINT NULL,
  title TEXT NULL,
  sku TEXT NULL,
  "priceCents" INTEGER NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GiftCampaignGiftItem_pkey" PRIMARY KEY (id),
  CONSTRAINT "GiftCampaignGiftItem_campaignId_shopId_fkey" FOREIGN KEY ("campaignId", "shopId") REFERENCES "GiftCampaign"(id, "shopId") ON DELETE CASCADE,
  CONSTRAINT "GiftCampaignGiftItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"(id) ON DELETE CASCADE,
  CONSTRAINT "GiftCampaignGiftItem_campaignId_pricingKey_key" UNIQUE ("campaignId", "pricingKey")
);

CREATE TABLE IF NOT EXISTS "GiftCampaignAction" (
  id BIGSERIAL NOT NULL,
  "campaignId" UUID NOT NULL,
  "shopId" INTEGER NOT NULL,
  action TEXT NOT NULL,
  "actorUserId" INTEGER NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GiftCampaignAction_pkey" PRIMARY KEY (id),
  CONSTRAINT "GiftCampaignAction_campaignId_shopId_fkey" FOREIGN KEY ("campaignId", "shopId") REFERENCES "GiftCampaign"(id, "shopId") ON DELETE CASCADE,
  CONSTRAINT "GiftCampaignAction_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "GiftCampaign_shopId_createdAt_idx"
  ON "GiftCampaign" ("shopId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "GiftCampaign_shopId_status_period_idx"
  ON "GiftCampaign" ("shopId", status, "startAt", "endAt");
CREATE INDEX IF NOT EXISTS "GiftCampaignMainItem_shopId_pricingKey_idx"
  ON "GiftCampaignMainItem" ("shopId", "pricingKey");
CREATE INDEX IF NOT EXISTS "GiftCampaignAction_campaignId_createdAt_idx"
  ON "GiftCampaignAction" ("campaignId", "createdAt" DESC);

COMMIT;
