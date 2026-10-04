import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { loadLegacyFresh } from '../legacyStubs/register';
import { world } from '../legacyStubs/state';
import { asyncSpec } from './asyncSpec';
import { T0, maybeFrac } from './common';
import { smallCount } from './seq';

const module = 'launch';

interface Item { name: string; path: string; args: string[]; scope: string; enabled: boolean }
interface Settings { openAtLogin: boolean; wasOpenedAtLogin: boolean; status: string; executableWillLaunchAtLogin: boolean; launchItems: Item[] }
type Get = Settings | { throws: string };
type Call = 'inspect' | 'reconcileOnBoot' | 'repair' | 'shouldStartHidden' | 'launchOrigin' | { t: 'move'; options: boolean };
type In = {
  platform: string;
  packaged: boolean;
  execPath: string;
  argv: string[];
  inApplications: boolean;
  now: number;
  gets: Get[];
  setThrows: number[];
  calls: Call[];
};

interface Service {
  inspect(): unknown;
  reconcileOnBoot(): unknown;
  repair(): unknown;
  shouldStartHidden(): boolean;
  launchOrigin(): string;
  moveToApplicationsFolder(options?: unknown): boolean;
}
interface LaunchModule {
  createLaunchAtLoginService(deps: unknown): Service;
}

function execute(mod: LaunchModule, input: In): unknown[] {
  const trace: unknown[] = [];
  let getIndex = 0;
  let setIndex = 0;
  const app = {
    isPackaged: input.packaged,
    getLoginItemSettings: (options?: unknown) => {
      const response = input.gets[Math.min(getIndex, input.gets.length - 1)];
      getIndex++;
      if (response === undefined) throw new Error('no scripted settings');
      if ('throws' in response) {
        trace.push({ e: 'get', query: options ?? null, threw: response.throws });
        throw new Error(response.throws);
      }
      trace.push({ e: 'get', query: options ?? null, threw: null });
      return response;
    },
    setLoginItemSettings: (settings: unknown) => {
      const index = setIndex++;
      const throws = input.setThrows.includes(index);
      trace.push({ e: 'set', settings, threw: throws ? 'set failed' : null });
      if (throws) throw new Error('set failed');
    },
    isInApplicationsFolder: () => { trace.push({ e: 'inApplications' }); return input.inApplications; },
    moveToApplicationsFolder: (options?: unknown) => { trace.push({ e: 'move', withOptions: options !== undefined }); return true; },
  };
  const take = (ret: unknown) => {
    const logs = world.logs.splice(0).map((l) => ({ level: l.level, message: l.message, meta: l.meta }));
    return { ret, trace: trace.splice(0), logs };
  };
  const steps: unknown[] = [];
  world.logs.length = 0;
  let service: Service;
  try {
    service = mod.createLaunchAtLoginService({ app, platform: input.platform, execPath: input.execPath, argv: input.argv, now: () => input.now });
  } catch (e) {
    return [take({ error: (e as Error).message })];
  }
  steps.push(take(null));
  for (const call of input.calls) {
    let ret: unknown;
    try {
      if (call === 'inspect') ret = service.inspect();
      else if (call === 'reconcileOnBoot') ret = service.reconcileOnBoot();
      else if (call === 'repair') ret = service.repair();
      else if (call === 'shouldStartHidden') ret = service.shouldStartHidden();
      else if (call === 'launchOrigin') ret = service.launchOrigin();
      else ret = call.options ? service.moveToApplicationsFolder({ conflictHandler: () => true }) : service.moveToApplicationsFolder();
    } catch (e) {
      ret = { error: (e as Error).message };
    }
    steps.push(take(ret));
  }
  return steps;
}

const EXES = [
  'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe',
  'c:\\users\\anish\\appdata\\local\\programs\\timo\\timo.exe',
  'D:\\Apps\\Timo\\Timo.exe',
  'C:\\Program Files\\Timo\\Timo.exe',
  '\\\\server\\share\\Timo.exe',
  'C:\\Users\\Ünï\\AppData\\Local\\Programs\\Timo\\Timo.exe',
];
const MAC_EXES = ['/Applications/Timo.app/Contents/MacOS/Timo', '/Volumes/Timo/Timo.app/Contents/MacOS/Timo'];
const NAMES = ['Timo', 'Timo', 'Timo', 'timo', ' Timo ', 'Grind', '@grind/agent', 'Timo time tracker desktop agent', 'TIMO TIME TRACKER DESKTOP AGENT', 'Timo Legacy', 'Other App', '', 'GRIND'];
const OTHER_PATHS = [
  'C:\\Old\\Timo\\Timo.exe', 'C:\\Old\\Timo.exe', 'C:\\Old\\Grind.exe', 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo-old\\Timo.exe', 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Grind\\Grind.exe',
  'C:\\Users\\Anish\\AppData\\Local\\Programs\\@grind\\agent.exe', 'C:\\Windows\\notepad.exe', 'C:\\Old\\timo\\TIMO.EXE', 'C:\\Old\\@Grind\\Agent.exe', '"C:\\Quoted\\Timo\\Timo.exe"', 'D:/Mixed/Timo/Timo.exe', '',
];
const STATUSES = ['enabled', 'enabled', 'not-registered', 'not-found', 'requires-approval', 'unknown', ''];

function genItem(rng: Rng, exec: string): Item {
  const pathPick = rng.weighted<string>([
    [exec, 45], [exec.toUpperCase(), 6], [`"${exec}"`, 6], [exec.replace(/\\/g, '/'), 5], [`${exec.replace(/Timo\.exe$/i, '')}.\\Timo.exe`, 3], [rng.pick(OTHER_PATHS), 35],
  ]);
  return { name: rng.pick(NAMES), path: pathPick, args: rng.chance(0.15) ? ['--hidden'] : [], scope: 'user', enabled: rng.chance(0.65) };
}

function genSettings(rng: Rng, exec: string): Settings {
  return {
    openAtLogin: rng.chance(0.5),
    wasOpenedAtLogin: rng.chance(0.3),
    status: rng.pick(STATUSES),
    executableWillLaunchAtLogin: rng.chance(0.5),
    launchItems: Array.from({ length: smallCount(rng, 0, 4) }, () => genItem(rng, exec)),
  };
}

function genIn(rng: Rng): In {
  const platform = rng.weighted<string>([['darwin', 40], ['win32', 50], ['linux', 8], ['freebsd', 2]]);
  const execPath = platform === 'darwin' ? rng.pick(MAC_EXES) : rng.pick(EXES);
  const gets: Get[] = Array.from({ length: rng.int(1, 6) }, () => (rng.chance(0.08) ? { throws: rng.pick(['boom', 'registry locked']) } : genSettings(rng, execPath)));
  const calls: Call[] = Array.from({ length: smallCount(rng, 1, 5) }, (): Call => {
    const kind = rng.weighted<string>([['inspect', 25], ['reconcileOnBoot', 25], ['repair', 25], ['shouldStartHidden', 5], ['launchOrigin', 5], ['move', 15]]);
    return kind === 'move' ? { t: 'move', options: rng.chance(0.5) } : (kind as Call);
  });
  return {
    platform,
    packaged: rng.chance(0.9),
    execPath,
    argv: rng.chance(0.5) ? ['Timo.exe', '--hidden'] : rng.chance(0.5) ? ['Timo.exe', 'timo://callback'] : [],
    inApplications: rng.chance(0.75),
    now: rng.chance(0.03) ? 8.64e15 + 1 : maybeFrac(rng, T0 + rng.int(-1000, 1000), 0.5),
    gets,
    setThrows: rng.chance(0.15) ? [rng.int(0, 4)] : [],
    calls,
  };
}

function edge(): In[] {
  const exe = EXES[0] as string;
  const base = { platform: 'win32', packaged: true, execPath: exe, argv: [] as string[], inApplications: true, now: 1783814400000, setThrows: [] as number[] };
  const s = (patch: Partial<Settings> = {}): Settings => ({ openAtLogin: false, wasOpenedAtLogin: false, status: 'not-registered', executableWillLaunchAtLogin: false, launchItems: [], ...patch });
  const it = (patch: Partial<Item> = {}): Item => ({ name: 'Timo', path: exe, args: [], scope: 'user', enabled: true, ...patch });
  const ready = s({ openAtLogin: true, executableWillLaunchAtLogin: true, launchItems: [it()] });
  const disabled = s({ openAtLogin: true, launchItems: [it({ enabled: false })] });
  const mac = { ...base, platform: 'darwin', execPath: MAC_EXES[0] as string };
  return [
    { ...base, gets: [s()], calls: ['inspect'] },
    { ...mac, gets: [s()], packaged: false, calls: ['reconcileOnBoot'] },
    { ...mac, gets: [s()], inApplications: false, calls: ['inspect', { t: 'move', options: true }] },
    { ...mac, gets: [s(), s(), s({ openAtLogin: true, status: 'enabled' }), s({ openAtLogin: true, status: 'enabled' })], calls: ['reconcileOnBoot'] },
    { ...mac, gets: [s({ openAtLogin: true, status: 'requires-approval' })], calls: ['reconcileOnBoot'] },
    { ...mac, gets: [s({ openAtLogin: true, status: 'enabled', wasOpenedAtLogin: true })], calls: ['shouldStartHidden', 'launchOrigin', 'inspect'] },
    { ...base, gets: [disabled], calls: ['inspect'] },
    { ...base, argv: ['Timo.exe', '--hidden'], gets: [ready], calls: ['inspect'] },
    { ...base, gets: [s({ openAtLogin: true, executableWillLaunchAtLogin: true })], calls: ['inspect'] },
    { ...base, argv: ['Timo.exe', '--hidden'], gets: [s()], calls: ['inspect'] },
    { ...base, argv: ['Timo.exe', '--hidden'], gets: [s({ launchItems: [it({ enabled: false })] })], calls: ['inspect'] },
    { ...base, gets: [s({ launchItems: [it({ enabled: false }), it({ name: 'Timo time tracker desktop agent', enabled: true })] })], calls: ['inspect'] },
    { ...base, gets: [s({ launchItems: [it({ name: 'Timo time tracker desktop agent' })] })], calls: ['inspect'] },
    { ...base, gets: [disabled, ready, ready, ready, ready], calls: ['reconcileOnBoot'] },
    { ...base, gets: [disabled, ready, ready, ready, ready], calls: ['repair'] },
    { ...base, gets: [disabled], calls: ['repair'] },
    { ...base, gets: [s({ launchItems: [it({ name: 'Timo time tracker desktop agent', path: 'C:\\Old\\Timo\\Timo.exe' })] })], calls: ['repair'] },
    {
      ...base,
      gets: [
        s({ launchItems: [it({ name: 'Grind', path: 'C:\\Old\\Grind.exe' }), it({ name: 'Timo time tracker desktop agent', path: 'C:\\Old\\Timo\\Timo.exe' }), it({ path: 'C:\\Old\\Timo.exe' }), it({ name: 'Timo Legacy', path: 'C:\\Old\\Timo\\Timo.exe' })] }),
        s({ openAtLogin: true, executableWillLaunchAtLogin: true, launchItems: [it(), it({ name: 'Grind', path: 'C:\\Old\\Grind.exe' })] }),
        s({ openAtLogin: true, executableWillLaunchAtLogin: true, launchItems: [it(), it({ name: 'Grind', path: 'C:\\Old\\Grind.exe' })] }),
        ready,
      ],
      calls: ['reconcileOnBoot'],
    },
    { ...base, gets: [s({ openAtLogin: true, executableWillLaunchAtLogin: true, launchItems: [it(), it({ name: 'Timo time tracker desktop agent', path: 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo-old\\Timo.exe' })] })], calls: ['repair'] },
    { ...base, gets: [s({ openAtLogin: true, executableWillLaunchAtLogin: true, launchItems: [it(), it({ name: 'Timo time tracker desktop agent' })] })], calls: ['reconcileOnBoot'] },
    // dedupe: the same verdict twice logs once
    { ...base, gets: [disabled], calls: ['inspect', 'inspect', 'inspect'] },
    // throws: get throws; set throws; invalid clock
    { ...base, gets: [{ throws: 'registry locked' }], calls: ['inspect', 'repair'] },
    { ...base, gets: [disabled], setThrows: [0], calls: ['repair'] },
    { ...base, gets: [ready], setThrows: [0], calls: ['reconcileOnBoot'] },
    { ...base, gets: [ready], setThrows: [1], calls: ['reconcileOnBoot'] },
    { ...base, gets: [ready, { throws: 'boom' }], now: 8.64e15 + 1, calls: ['inspect'] },
    { ...mac, gets: [{ throws: 'boom' }], calls: ['inspect', 'shouldStartHidden'] },
    { ...base, platform: 'linux', gets: [s()], calls: ['inspect', 'launchOrigin', 'repair'] },
    { ...base, platform: 'linux', gets: [disabled], calls: ['repair'] },
  ];
}

// A fresh module instance per case, so the module-level "last logged" memo starts empty.
const launchSpec = await asyncSpec<In>({
  module,
  fn: 'service',
  edge,
  random: genIn,
  run: async (input) => execute(await loadLegacyFresh<LaunchModule>('services/launchAtLogin.ts'), input),
});

export const specs: FnSpec<any>[] = [launchSpec];
