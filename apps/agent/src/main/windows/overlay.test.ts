import { describe, it, expect } from 'vitest';
import { centerUpperThird, topRight, bottomRight, trayPopoverPoint, type Rect } from './overlay';

const SIZE = { width: 320, height: 168 };
const PRIMARY: Rect = { x: 0, y: 0, width: 1440, height: 900 };
// A second monitor to the right, with a non-zero origin.
const SECOND: Rect = { x: 1440, y: 0, width: 1920, height: 1080 };

describe('centerUpperThird', () => {
  it('centers horizontally and sits one-third down', () => {
    const p = centerUpperThird(PRIMARY, SIZE);
    expect(p.x).toBe(Math.round((1440 - 320) / 2));
    expect(p.y).toBe(Math.round((900 - 168) / 3));
  });

  it('respects a non-zero display origin (secondary monitor)', () => {
    const p = centerUpperThird(SECOND, SIZE);
    expect(p.x).toBe(Math.round(1440 + (1920 - 320) / 2));
    expect(p.y).toBe(Math.round((1080 - 168) / 3));
  });
});

describe('topRight', () => {
  it('pins to the top-right with the default gutter', () => {
    const p = topRight(PRIMARY, SIZE);
    expect(p.x).toBe(1440 - 320 - 16);
    expect(p.y).toBe(16);
  });

  it('lands on the secondary monitor when given its work area', () => {
    const p = topRight(SECOND, SIZE);
    expect(p.x).toBe(1440 + 1920 - 320 - 16);
    expect(p.y).toBe(16);
  });

  it('honors a custom gutter', () => {
    const p = topRight(PRIMARY, SIZE, 40);
    expect(p.x).toBe(1440 - 320 - 40);
    expect(p.y).toBe(40);
  });
});

describe('bottomRight', () => {
  it('pins to the bottom-right with the default gutter', () => {
    const p = bottomRight(PRIMARY, SIZE);
    expect(p.x).toBe(1440 - 320 - 20);
    expect(p.y).toBe(900 - 168 - 20);
  });

  it('accounts for a macOS menu-bar / dock inset (non-zero y origin)', () => {
    const inset: Rect = { x: 0, y: 25, width: 1440, height: 850 };
    const p = bottomRight(inset, SIZE);
    expect(p.y).toBe(25 + 850 - 168 - 20);
  });
});

describe('trayPopoverPoint', () => {
  const POPOVER = { width: 300, height: 340 };

  it('opens below a macOS-style top menu bar tray icon', () => {
    const wa: Rect = { x: 0, y: 25, width: 1440, height: 875 };
    const tray: Rect = { x: 1180, y: 0, width: 24, height: 24 };
    const p = trayPopoverPoint(tray, wa, POPOVER);

    expect(p.y).toBe(31);
    expect(p.x).toBe(Math.round(1180 + 12 - 150));
  });

  it('opens above a Windows bottom taskbar tray icon', () => {
    const wa: Rect = { x: 0, y: 0, width: 1440, height: 860 };
    const tray: Rect = { x: 1320, y: 860, width: 24, height: 40 };
    const p = trayPopoverPoint(tray, wa, POPOVER);

    expect(p.y).toBe(860 - 340 - 6);
    expect(p.x).toBe(1440 - 300 - 6);
  });

  it('keeps the popover inside a small work area', () => {
    const wa: Rect = { x: 100, y: 50, width: 320, height: 360 };
    const tray: Rect = { x: 390, y: 390, width: 24, height: 24 };
    const p = trayPopoverPoint(tray, wa, POPOVER);

    expect(p.x).toBe(114);
    expect(p.y).toBe(56);
  });
});
