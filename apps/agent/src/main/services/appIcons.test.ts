import { describe, expect, it } from 'vitest';
import { MAX_BATCH_BYTES, macAppBundlePath, macIconFileNames, packIconBatch } from './appIcons';

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

describe('app icon upload batches', () => {
  const icon = (i: number, bytes = 3_000) => ({ bundleId: `com.example.${i}`, app: `App ${i}`, pngBase64: 'A'.repeat(bytes) });

  it('keeps every request under the API body limit', () => {
    const queued = Array.from({ length: 50 }, (_, i) => icon(i));
    const { batch, oversized } = packIconBatch(queued);
    expect(oversized).toEqual([]);
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThan(50);
    expect(Buffer.byteLength(JSON.stringify({ icons: batch }))).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    expect(batch.map((b) => b.bundleId)).toEqual(queued.slice(0, batch.length).map((b) => b.bundleId));
  });

  it('sets aside an icon that could never fit instead of retrying it forever', () => {
    const { batch, oversized } = packIconBatch([icon(1, 60_000), icon(2)]);
    expect(oversized.map((b) => b.bundleId)).toEqual(['com.example.1']);
    expect(batch.map((b) => b.bundleId)).toEqual(['com.example.2']);
  });
});
