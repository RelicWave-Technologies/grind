import { world } from './state';

const write = (level: string) => (message: string, meta?: unknown): void => {
  world.logs.push({ level, message, meta: meta ?? null });
};

export const log = { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
export const flushLogs = (): void => undefined;
