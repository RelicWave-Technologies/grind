import { describe, it, expect } from 'vitest';
import { isMeetingApp, MeetingTracker } from './detect';

describe('isMeetingApp', () => {
  it('matches known bundle ids', () => {
    expect(isMeetingApp(undefined, 'us.zoom.xos')).toBe(true);
    expect(isMeetingApp(undefined, 'com.microsoft.teams2')).toBe(true);
    expect(isMeetingApp(undefined, 'com.cisco.webexmeetingsapp')).toBe(true);
  });
  it('matches by name hint (case-insensitive)', () => {
    expect(isMeetingApp('zoom.us')).toBe(true);
    expect(isMeetingApp('Microsoft Teams')).toBe(true);
    expect(isMeetingApp('Webex')).toBe(true);
  });
  it('does not match non-meeting apps', () => {
    expect(isMeetingApp('Visual Studio Code', 'com.microsoft.VSCode')).toBe(false);
    expect(isMeetingApp('Safari', 'com.apple.Safari')).toBe(false);
    expect(isMeetingApp(null, null)).toBe(false);
  });
});

describe('MeetingTracker', () => {
  it('enters immediately, exits after grace', () => {
    const t = new MeetingTracker(3);
    expect(t.update(true)).toEqual({ inMeeting: true, changed: true });
    expect(t.update(true)).toEqual({ inMeeting: true, changed: false });
    // brief switch away — within grace, still in meeting
    expect(t.update(false)).toEqual({ inMeeting: true, changed: false });
    expect(t.update(false)).toEqual({ inMeeting: true, changed: false });
    expect(t.update(false)).toEqual({ inMeeting: false, changed: true }); // 3rd miss → exit
  });

  it('resets miss count when meeting reappears', () => {
    const t = new MeetingTracker(3);
    t.update(true);
    t.update(false);
    t.update(false);
    expect(t.update(true)).toEqual({ inMeeting: true, changed: false }); // back, resets
    expect(t.update(false)).toEqual({ inMeeting: true, changed: false }); // miss 1 again
  });

  it('stays out when never in a meeting', () => {
    const t = new MeetingTracker(3);
    expect(t.update(false)).toEqual({ inMeeting: false, changed: false });
    expect(t.isInMeeting()).toBe(false);
  });
});
