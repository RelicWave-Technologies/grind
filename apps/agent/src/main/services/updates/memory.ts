import fs from 'node:fs';

/**
 * The few update decisions that must survive a restart. Tiny JSON file in
 * userData; a missing or corrupt file reads as "nothing remembered", and a
 * failed write only means a decision may be made once more — neither may ever
 * block boot.
 */
export interface UpdateMemory {
  /** Install path the "can't update itself here" notice was shown for. */
  machineInstallNoticeFor: string | null;
  /** Version a launch-time install was last attempted for (at most once each). */
  launchInstallTriedFor: string | null;
}

const EMPTY: UpdateMemory = { machineInstallNoticeFor: null, launchInstallTriedFor: null };

type FsLike = Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'renameSync'>;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createUpdateMemory(file: string, fsImpl: FsLike = fs) {
  function read(): UpdateMemory {
    try {
      const parsed = JSON.parse(String(fsImpl.readFileSync(file, 'utf8'))) as Record<string, unknown>;
      return {
        machineInstallNoticeFor: stringOrNull(parsed.machineInstallNoticeFor),
        launchInstallTriedFor: stringOrNull(parsed.launchInstallTriedFor),
      };
    } catch {
      return { ...EMPTY };
    }
  }

  function write(patch: Partial<UpdateMemory>): boolean {
    try {
      const next = { ...read(), ...patch };
      const temp = `${file}.tmp`;
      fsImpl.writeFileSync(temp, `${JSON.stringify(next)}\n`);
      fsImpl.renameSync(temp, file);
      return true;
    } catch {
      return false;
    }
  }

  return { read, write };
}

export type UpdateMemoryStore = ReturnType<typeof createUpdateMemory>;

/** Normalised so a differently-cased path to the same install counts as seen. */
export function noticeKey(execPath: string): string {
  return execPath.replace(/\//g, '\\').toLowerCase();
}

/**
 * Show the machine-install notice once per install. Records it BEFORE showing,
 * so a crash or a quit mid-dialog cannot turn it into a notice on every boot.
 * Returns false when it was already shown, or when it cannot be recorded (an
 * unwritable userData would otherwise repeat it on every launch).
 */
export function claimMachineInstallNotice(store: UpdateMemoryStore, execPath: string): boolean {
  const key = noticeKey(execPath);
  if (store.read().machineInstallNoticeFor === key) return false;
  return store.write({ machineInstallNoticeFor: key });
}

/** At most one automatic launch-time install per version — never a restart loop. */
export function claimLaunchInstall(store: UpdateMemoryStore, version: string): boolean {
  if (store.read().launchInstallTriedFor === version) return false;
  return store.write({ launchInstallTriedFor: version });
}
