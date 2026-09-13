-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "ratingOver500" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ratingSyncedAt" TIMESTAMP(3);
