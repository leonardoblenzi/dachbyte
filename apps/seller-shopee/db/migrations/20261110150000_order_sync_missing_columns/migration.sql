-- Colunas de "Order" que a sincronizacao de pedidos e os paineis usam, mas que nenhuma
-- migracao criava (o banco antigo as tinha por fora). Sem elas o primeiro pedido nao grava
-- e os paineis falham com 'column o."shippingCarrier" does not exist'.
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "orderId" BIGINT,
  ADD COLUMN IF NOT EXISTS "orderNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "estimatedShippingFeeCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "shippingCarrier" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT;
