-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "sourceCity" TEXT;

-- CreateTable
CREATE TABLE "EventMovie" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "tmdbId" INTEGER,
    "mediaType" TEXT,
    "title" TEXT,
    "originalTitle" TEXT,
    "releaseYear" INTEGER,
    "overview" TEXT,
    "posterUrl" TEXT,
    "backdropUrl" TEXT,
    "trailerEmbedUrl" TEXT,
    "trailerUrl" TEXT,
    "trailerKey" TEXT,
    "voteAverage" DOUBLE PRECISION,
    "runtime" INTEGER,
    "ageRating" TEXT,
    "genres" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventMovie_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventMovie_eventId_key" ON "EventMovie"("eventId");

-- CreateIndex
CREATE INDEX "EventMovie_tmdbId_idx" ON "EventMovie"("tmdbId");

-- CreateIndex
CREATE INDEX "Event_source_sourceCity_status_idx" ON "Event"("source", "sourceCity", "status");

-- AddForeignKey
ALTER TABLE "EventMovie" ADD CONSTRAINT "EventMovie_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
