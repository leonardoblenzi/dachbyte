-- Colunas de repasse (escrow/income) de "Order" que a sincronizacao financeira grava e que o
-- Painel de Controle, a margem e a lista de pedidos leem. Nenhuma migracao as criava.
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "incomeSyncedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "incomeStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "incomeNetCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "finCommissionCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "finServiceFeeCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "finTransactionFeeCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "finShippingFeeCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "finVoucherSellerCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "finVoucherShopeeCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "finShopeeDiscountCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "finDiscountFromCoinCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "finDiscountVoucherShopeeCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "finDiscountVoucherSellerCents" INTEGER NOT NULL DEFAULT 0;
