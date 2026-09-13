-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "quotedFreightDate" TIMESTAMP(3),
ADD COLUMN     "quotedFreightDetails" JSONB,
ADD COLUMN     "quotedFreightValue" DOUBLE PRECISION,
ALTER COLUMN "freightValue" DROP NOT NULL;
