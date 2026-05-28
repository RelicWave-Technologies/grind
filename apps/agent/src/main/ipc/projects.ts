import { ipcMain } from 'electron';
import type { ProjectListResponse } from '@grind/types';
import { api } from '../services/apiClient';

export function registerProjectsIpc(): void {
  ipcMain.handle('projects:list', async () => {
    const res = await api<ProjectListResponse>('/v1/projects');
    return res.projects;
  });
}
