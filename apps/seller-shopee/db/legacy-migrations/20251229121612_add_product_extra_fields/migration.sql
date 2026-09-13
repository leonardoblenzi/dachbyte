-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "daysToShip" INTEGER,
ADD COLUMN     "dimension" JSONB,
ADD COLUMN     "logistics" JSONB,
ADD COLUMN     "weight" DOUBLE PRECISION;
