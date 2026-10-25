-- Дедупликация событий из разных источников.
-- duplicateOfId указывает на основное событие; NULL = событие основное.

-- AlterTable
ALTER TABLE "Event" ADD COLUMN "duplicateOfId" TEXT;

-- CreateIndex
CREATE INDEX "Event_duplicateOfId_idx" ON "Event"("duplicateOfId");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
