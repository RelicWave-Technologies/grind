import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const installer = readFileSync(new URL('../../../build/installer.nsh', import.meta.url), 'utf8');

describe('Windows installer startup cleanup', () => {
  it('removes legacy launch entries during install', () => {
    expect(installer).toContain('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "Grind"');
    expect(installer).toContain('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "@grind/agent"');
  });

  it.each(['Timo', 'Grind', '@grind/agent'])('removes %s startup residue during uninstall', (name) => {
    expect(installer).toContain(`DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${name}"`);
    expect(installer).toContain(`DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "${name}"`);
    expect(installer).toContain(`DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32" "${name}"`);
  });
});
