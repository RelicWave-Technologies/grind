import { describe, expect, it } from 'vitest';
import { macAppBundlePath, macIconFileNames } from './appIcons';

describe('mac app icon metadata', () => {
  it('finds the containing app bundle from bundle and executable paths', () => {
    expect(macAppBundlePath('/Applications/ChatGPT.app')).toBe('/Applications/ChatGPT.app');
    expect(macAppBundlePath('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT')).toBe('/Applications/ChatGPT.app');
    expect(macAppBundlePath('/usr/bin/node')).toBeNull();
  });

  it('prefers declared icon files and normalizes extensionless names', () => {
    expect(
      macIconFileNames({
        CFBundleIconFile: 'Timo',
        CFBundleIconFiles: ['Small.icns', 'Timo'],
        CFBundleIcons: {
          CFBundlePrimaryIcon: {
            CFBundleIconName: 'PrimaryIcon',
            CFBundleIconFiles: ['Primary16', 'Primary32.icns'],
          },
        },
      }),
    ).toEqual(['Timo.icns', 'Small.icns', 'PrimaryIcon.icns', 'Primary16.icns', 'Primary32.icns']);
  });

  it('keeps icon lookup inside the app Resources directory', () => {
    expect(macIconFileNames({ CFBundleIconFile: '../../outside' })).toEqual(['outside.icns']);
    expect(macIconFileNames({ CFBundleIconFile: 'icon.png' })).toEqual([]);
  });
});
