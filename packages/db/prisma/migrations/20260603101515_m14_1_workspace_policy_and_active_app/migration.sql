-- AlterTable
ALTER TABLE "ActivitySample" ADD COLUMN     "activeApp" TEXT,
ADD COLUMN     "activeAppBundle" TEXT,
ADD COLUMN     "activeTitle" TEXT,
ADD COLUMN     "activeUrl" TEXT;

-- CreateTable
CREATE TABLE "WorkspacePolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "captureApps" BOOLEAN NOT NULL DEFAULT false,
    "captureTitles" BOOLEAN NOT NULL DEFAULT false,
    "captureUrls" BOOLEAN NOT NULL DEFAULT false,
    "retentionDaysScreenshots" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspacePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspacePolicy_workspaceId_key" ON "WorkspacePolicy"("workspaceId");

-- CreateIndex
CREATE INDEX "ActivitySample_userId_activeApp_idx" ON "ActivitySample"("userId", "activeApp");

-- AddForeignKey
ALTER TABLE "WorkspacePolicy" ADD CONSTRAINT "WorkspacePolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
