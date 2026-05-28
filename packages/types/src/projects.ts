import { z } from 'zod';

export const ProjectDto = z.object({
  id: z.string(),
  name: z.string(),
  archived: z.boolean(),
});
export type ProjectDto = z.infer<typeof ProjectDto>;

export const ProjectListResponse = z.object({
  projects: z.array(ProjectDto),
});
export type ProjectListResponse = z.infer<typeof ProjectListResponse>;
