import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await argon2.hash('grindgrind', { type: argon2.argon2id });

  const ws = await prisma.workspace.upsert({
    where: { id: 'ws_dogfood' },
    update: {},
    create: { id: 'ws_dogfood', name: 'EmiAC Dogfood' },
  });

  const owner = await prisma.user.upsert({
    where: { email: 'abhishek@emiactech.com' },
    update: { passwordHash, role: 'OWNER', workspaceId: ws.id },
    create: {
      workspaceId: ws.id,
      email: 'abhishek@emiactech.com',
      name: 'Anish Suman',
      role: 'OWNER',
      passwordHash,
    },
  });

  console.log(`Seeded: workspace=${ws.id} user=${owner.email} (projects removed — tracker is Lark-task-only now)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
