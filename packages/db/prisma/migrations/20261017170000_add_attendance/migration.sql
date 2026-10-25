-- «Пойду»: отметки пользователей и новые типы сигналов для рекомендаций.

-- AlterEnum
ALTER TYPE "InteractionType" ADD VALUE 'GOING';
ALTER TYPE "InteractionType" ADD VALUE 'NOT_GOING';

-- CreateTable
CREATE TABLE "Attendance" (
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "maxRecipientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("userId","eventId")
);

-- CreateIndex
CREATE INDEX "Attendance_eventId_idx" ON "Attendance"("eventId");

-- CreateIndex
CREATE INDEX "Attendance_startsAt_reminderSentAt_idx" ON "Attendance"("startsAt", "reminderSentAt");

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
