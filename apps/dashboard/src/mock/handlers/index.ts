import { registerLeave } from './leave';
import { registerOps } from './ops';
import { registerPeople } from './people';
import { registerReports } from './reports';
import { registerSession } from './session';
import { registerTime } from './time';

let registered = false;

export function registerAll(): void {
  if (registered) return;
  registered = true;
  registerSession();
  registerTime();
  registerReports();
  registerPeople();
  registerOps();
  registerLeave();
}
