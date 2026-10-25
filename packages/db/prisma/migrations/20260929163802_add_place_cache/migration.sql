-- CreateTable
CREATE TABLE "Place" (
    "id" TEXT NOT NULL,
    "queryKey" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "city" TEXT,
    "countryCode" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'nominatim',
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Place_queryKey_key" ON "Place"("queryKey");

-- CreateIndex
CREATE INDEX "Place_city_idx" ON "Place"("city");

-- CreateIndex
CREATE INDEX "Place_name_idx" ON "Place"("name");
