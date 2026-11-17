-- 为打印试卷增加稳定短码。字段可空，确保既有数据无损升级；SQLite 唯一索引允许多个 NULL。
ALTER TABLE "ExamPaper" ADD COLUMN "printCode" TEXT;

CREATE UNIQUE INDEX "ExamPaper_printCode_key" ON "ExamPaper"("printCode");
