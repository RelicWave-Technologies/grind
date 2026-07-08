CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiToken_publicId_key" ON "ApiToken"("publicId");
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");
CREATE INDEX "ApiToken_workspaceId_revokedAt_idx" ON "ApiToken"("workspaceId", "revokedAt");
CREATE INDEX "ApiToken_createdById_idx" ON "ApiToken"("createdById");

ALTER TABLE "ApiToken"
ADD CONSTRAINT "ApiToken_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApiToken"
ADD CONSTRAINT "ApiToken_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
