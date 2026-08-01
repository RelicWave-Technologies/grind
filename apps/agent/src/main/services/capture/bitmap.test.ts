import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn() },
  screen: { getAllDisplays: () => [] },
  app: { getPath: () => '/tmp' },
}));

const { bgraToRgbaInPlace } = await import('./capture');

/**
 * `nativeImage.toBitmap()` hands back B,G,R,A; sharp's raw reader only speaks
 * R,G,B,A. Nothing downstream would fail loudly if the swap were wrong — the
 * screenshots would just silently come out with red and blue exchanged — so the
 * conversion is pinned here against real sharp decoding.
 */
describe('bgraToRgbaInPlace', () => {
  it('swaps the blue and red bytes while leaving green and alpha alone', () => {
    // One pixel, BGRA: B=0x10 G=0x20 R=0x30 A=0x40
    const bmp = Buffer.from([0x10, 0x20, 0x30, 0x40]);

    expect([...bgraToRgbaInPlace(bmp)]).toEqual([0x30, 0x20, 0x10, 0x40]);
  });

  it('round-trips known colours through sharp exactly as the capture path does', async () => {
    const width = 3;
    const height = 1;
    const red = [255, 0, 0];
    const green = [0, 255, 0];
    const blue = [0, 0, 255];
    const expected = [...red, ...green, ...blue];

    // What the OS would hand us for those pixels: B,G,R,A per pixel.
    const bgra = Buffer.from([
      0, 0, 255, 255, // red
      0, 255, 0, 255, // green
      255, 0, 0, 255, // blue
    ]);

    const rgb = await sharp(bgraToRgbaInPlace(bgra), { raw: { width, height, channels: 4 } })
      .removeAlpha()
      .raw()
      .toBuffer();

    expect([...rgb]).toEqual(expected);
  });

  it('handles a buffer with a non-zero byteOffset', async () => {
    // Buffer.from(array) can hand back a view into a larger pooled ArrayBuffer,
    // so the Uint32Array view must respect byteOffset or it reads the wrong
    // pixels entirely.
    const backing = Buffer.alloc(12);
    const view = backing.subarray(4, 8);
    view.set([0x10, 0x20, 0x30, 0x40]);

    bgraToRgbaInPlace(view);

    expect([...view]).toEqual([0x30, 0x20, 0x10, 0x40]);
    // Neighbouring bytes are untouched.
    expect([...backing.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...backing.subarray(8, 12)]).toEqual([0, 0, 0, 0]);
  });
});
