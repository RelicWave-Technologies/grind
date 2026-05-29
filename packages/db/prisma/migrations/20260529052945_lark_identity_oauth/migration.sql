-- CreateTable
CREATE TABLE "LarkIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "unionId" TEXT,
    "userIdLark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LarkIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LarkOAuthToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT NOT NULL,
    "reauthRequired" BOOLEAN NOT NULL DEFAULT false,
    "lastRefreshedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LarkOAuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LarkIdentity_userId_key" ON "LarkIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LarkIdentity_openId_key" ON "LarkIdentity"("openId");

-- CreateIndex
CREATE INDEX "LarkIdentity_openId_idx" ON "LarkIdentity"("openId");

-- CreateIndex
CREATE UNIQUE INDEX "LarkOAuthToken_userId_key" ON "LarkOAuthToken"("userId");

-- AddForeignKey
ALTER TABLE "LarkIdentity" ADD CONSTRAINT "LarkIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LarkOAuthToken" ADD CONSTRAINT "LarkOAuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
