-- CreateTable
CREATE TABLE "AdsCampaignGroup" (
    "id" SERIAL NOT NULL,
    "shopId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsCampaignGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsCampaignGroupCampaign" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "campaignId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsCampaignGroupCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsCampaignGroup_shopId_name_idx" ON "AdsCampaignGroup"("shopId", "name");

-- CreateIndex
CREATE INDEX "AdsCampaignGroupCampaign_campaignId_idx" ON "AdsCampaignGroupCampaign"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsCampaignGroupCampaign_groupId_campaignId_key" ON "AdsCampaignGroupCampaign"("groupId", "campaignId");

-- AddForeignKey
ALTER TABLE "AdsCampaignGroup" ADD CONSTRAINT "AdsCampaignGroup_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsCampaignGroupCampaign" ADD CONSTRAINT "AdsCampaignGroupCampaign_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AdsCampaignGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
