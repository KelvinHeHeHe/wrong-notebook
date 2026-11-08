-- 仅做增量变更：旧表新增可空列或带安全默认值的列，不重建、不改写旧记录。

-- AlterTable
ALTER TABLE "ExamPaper" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'generated';
ALTER TABLE "ExamPaper" ADD COLUMN "subjectId" TEXT;
ALTER TABLE "ExamPaper" ADD COLUMN "gradeSemester" TEXT;
ALTER TABLE "ExamPaper" ADD COLUMN "examType" TEXT;
ALTER TABLE "ExamPaper" ADD COLUMN "examDate" DATETIME;
ALTER TABLE "ExamPaper" ADD COLUMN "totalScore" REAL;
ALTER TABLE "ExamPaper" ADD COLUMN "sourceFileName" TEXT;

-- AlterTable
ALTER TABLE "ExamQuestion" ADD COLUMN "externalNumber" TEXT;
ALTER TABLE "ExamQuestion" ADD COLUMN "pageNumber" INTEGER;
ALTER TABLE "ExamQuestion" ADD COLUMN "regionJson" TEXT;
ALTER TABLE "ExamQuestion" ADD COLUMN "recognitionConfidence" REAL;

-- AlterTable
ALTER TABLE "PracticeRecord" ADD COLUMN "examAttemptId" TEXT;

-- CreateTable
CREATE TABLE "ExamPaperPage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'questions',
    "imageData" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "checksum" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExamPaperPage_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "ExamPaper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExamAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "takenAt" DATETIME NOT NULL,
    "totalScore" REAL,
    "maxScore" REAL,
    "comment" TEXT,
    "confirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExamAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExamAttempt_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "ExamPaper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExamAttemptPage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "imageData" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "checksum" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExamAttemptPage_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExamAttemptAnswer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "examQuestionId" TEXT NOT NULL,
    "recognizedAnswer" TEXT,
    "result" TEXT,
    "awardedScore" REAL,
    "maxScore" REAL,
    "gradingSource" TEXT,
    "gradingReason" TEXT,
    "confidence" REAL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "regionJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExamAttemptAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExamAttemptAnswer_examQuestionId_fkey" FOREIGN KEY ("examQuestionId") REFERENCES "ExamQuestion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ExamPaper_subjectId_idx" ON "ExamPaper"("subjectId");

-- CreateIndex
CREATE INDEX "PracticeRecord_examAttemptId_idx" ON "PracticeRecord"("examAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeRecord_examAttemptId_examQuestionId_key" ON "PracticeRecord"("examAttemptId", "examQuestionId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamPaperPage_paperId_role_order_key" ON "ExamPaperPage"("paperId", "role", "order");

-- CreateIndex
CREATE INDEX "ExamPaperPage_paperId_order_idx" ON "ExamPaperPage"("paperId", "order");

-- CreateIndex
CREATE INDEX "ExamAttempt_userId_takenAt_idx" ON "ExamAttempt"("userId", "takenAt");

-- CreateIndex
CREATE INDEX "ExamAttempt_paperId_takenAt_idx" ON "ExamAttempt"("paperId", "takenAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttemptPage_attemptId_order_key" ON "ExamAttemptPage"("attemptId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttemptAnswer_attemptId_examQuestionId_key" ON "ExamAttemptAnswer"("attemptId", "examQuestionId");

-- CreateIndex
CREATE INDEX "ExamAttemptAnswer_attemptId_reviewStatus_idx" ON "ExamAttemptAnswer"("attemptId", "reviewStatus");
