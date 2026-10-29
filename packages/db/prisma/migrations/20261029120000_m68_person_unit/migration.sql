-- The employer a person works for (EMIAC or MACOBS). Teams do not divide along
-- company lines, so the company sits on the person; HR downloads the month
-- sheet one unit at a time. Additive: nobody is assigned here — admins set it
-- on People (or the opt-in backfill script assigns by email domain).

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "unitId" TEXT;

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Unit_workspaceId_name_key" ON "Unit"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "User_unitId_idx" ON "User"("unitId");

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The two companies this workspace runs, for every workspace.
INSERT INTO "Unit" ("id", "workspaceId", "name")
SELECT 'unit_emiac_' || w."id", w."id", 'EMIAC' FROM "Workspace" w
UNION ALL
SELECT 'unit_macobs_' || w."id", w."id", 'MACOBS' FROM "Workspace" w
ON CONFLICT ("workspaceId", "name") DO NOTHING;
