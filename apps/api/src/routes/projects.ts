import { Router } from 'express';
import { prisma } from '@grind/db';
import type { ProjectListResponse } from '@grind/types';
import { requireAccessToken } from '../middleware/auth';

export const projectsRouter = Router();

projectsRouter.use(requireAccessToken);

projectsRouter.get('/', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const projects = await prisma.project.findMany({
      where: { workspaceId: req.user.ws, archived: false },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, archived: true },
    });
    const response: ProjectListResponse = { projects };
    res.json(response);
  } catch (err) {
    next(err);
  }
});
