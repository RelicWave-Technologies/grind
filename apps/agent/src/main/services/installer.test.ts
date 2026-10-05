import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const installer = readFileSync(new URL('../../../build/installer.nsh', import.meta.url), 'utf8');
const builderConfig = readFileSync(new URL('../../../electron-builder.yml', import.meta.url), 'utf8');

function nsisOption(name: string): string | null {
  const nsis = /^nsis:\n((?:[ ]{2}.*\n?)*)/m.exec(builderConfig)?.[1] ?? '';
  return new RegExp(`^  ${name}: (.+)$`, 'm').exec(nsis)?.[1]?.trim() ?? null;
}

describe('Windows installer install scope', () => {
  // A Program Files install cannot update itself (the updater runs the
  // installer unelevated), so every path into one stays closed.
  it('builds a per-user installer with no elevation or folder choice', () => {
    expect(nsisOption('oneClick')).toBe('false');
    expect(nsisOption('perMachine')).toBe('false');
    expect(nsisOption('allowElevation')).toBe('false');
    expect(nsisOption('allowToChangeInstallationDirectory')).toBe('false');
  });

  it('forces "only for me" in the installer, not the uninstaller', () => {
    const macro = /!macro customInstallMode\n([\s\S]*?)!macroend/.exec(installer)?.[1] ?? '';
    expect(macro).toContain('!ifndef BUILD_UNINSTALLER');
    expect(macro).toContain('StrCpy $isForceCurrentInstall "1"');
    expect(macro).not.toContain('isForceMachineInstall');
  });

  it('keeps the update feed on the per-user channel config', () => {
    expect(builderConfig).toMatch(/publish:\n  provider: github\n  owner: RelicWave-Technologies\n  repo: grind/);
  });
});

describe('Windows installer startup cleanup', () => {
  it('removes legacy launch entries during install', () => {
    expect(installer).toContain('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "Timo"');
    expect(installer).toContain('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "Timo time tracker desktop agent"');
    expect(installer).toContain('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "Grind"');
    expect(installer).toContain('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "@grind/agent"');
  });

  it.each(['Timo', 'Timo time tracker desktop agent', 'Grind', '@grind/agent'])('removes %s startup residue during uninstall', (name) => {
    expect(installer).toContain(`DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${name}"`);
    expect(installer).toContain(`DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "${name}"`);
    expect(installer).toContain(`DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32" "${name}"`);
  });
});
