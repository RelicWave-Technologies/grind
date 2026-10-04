import { world } from './state';

export const getTimerService = (): unknown => ({ status: () => world.timerStatus() });
