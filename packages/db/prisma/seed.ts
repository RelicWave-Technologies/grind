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

  const projects = [
    { id: 'proj_grind_tracker', name: 'Grind Tracker' },
    { id: 'proj_client_work', name: 'Client Work' },
    { id: 'proj_admin_ops', name: 'Admin & Ops' },
  ];

  for (const p of projects) {
    await prisma.project.upsert({
      where: { id: p.id },
      update: { name: p.name, workspaceId: ws.id },
      create: { id: p.id, name: p.name, workspaceId: ws.id },
    });
  }

  console.log(`Seeded: workspace=${ws.id} user=${owner.email} projects=${projects.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
