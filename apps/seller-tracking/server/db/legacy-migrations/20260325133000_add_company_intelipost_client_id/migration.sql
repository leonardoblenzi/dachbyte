ALTER TABLE "Company"
ADD COLUMN "intelipostClientId" TEXT;

UPDATE "Company"
SET "intelipostClientId" = '40115'
WHERE UPPER("name") = 'DROSSI INTERIORES';
