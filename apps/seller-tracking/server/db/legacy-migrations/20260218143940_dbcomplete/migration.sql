/*
  Warnings:

  - Added the required column `password` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CREATED', 'SHIPPED', 'DELIVERY_ATTEMPT', 'DELIVERED', 'FAILURE', 'RETURNED', 'CANCELED', 'CHANNEL_LOGISTICS');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "password" TEXT NOT NULL,
ADD COLUMN     "role" "Role" NOT NULL DEFAULT 'USER',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "Carrier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiType" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Carrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "trackingCode" TEXT,
    "customerName" TEXT NOT NULL,
    "corporateName" TEXT,
    "cpf" TEXT,
    "cnpj" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "salesChannel" TEXT NOT NULL,
    "freightType" TEXT,
    "freightValue" DOUBLE PRECISION NOT NULL,
    "shippingDate" TIMESTAMP(3),
    "carrierId" TEXT,
    "address" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "complement" TEXT,
    "neighborhood" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zipCode" TEXT NOT NULL,
    "totalValue" DOUBLE PRECISION NOT NULL,
    "recipient" TEXT,
    "maxShippingDeadline" TIMESTAMP(3),
    "estimatedDeliveryDate" TIMESTAMP(3),
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "isDelayed" BOOLEAN NOT NULL DEFAULT false,
    "lastApiSync" TIMESTAMP(3),
    "lastUpdate" TIMESTAMP(3) NOT NULL,
    "lastApiError" TEXT,
    "apiRawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "city" TEXT,
    "state" TEXT,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Carrier_name_key" ON "Carrier"("name");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_orderNumber_idx" ON "Order"("orderNumber");

-- CreateIndex
CREATE INDEX "Order_invoiceNumber_idx" ON "Order"("invoiceNumber");

-- CreateIndex
CREATE INDEX "Order_trackingCode_idx" ON "Order"("trackingCode");

-- CreateIndex
CREATE INDEX "Order_isDelayed_idx" ON "Order"("isDelayed");

-- CreateIndex
CREATE INDEX "Order_lastApiSync_idx" ON "Order"("lastApiSync");

-- CreateIndex
CREATE INDEX "TrackingEvent_orderId_idx" ON "TrackingEvent"("orderId");

-- CreateIndex
CREATE INDEX "TrackingEvent_eventDate_idx" ON "TrackingEvent"("eventDate");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
