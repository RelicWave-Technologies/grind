/**
 * Pure meeting-detection logic (no Electron), so it's unit-testable.
 *
 * We detect "in a meeting" from the foreground app being a known video-call app
 * (Zoom / Teams / Webex desktop). Browser-based Meet and Slack huddles need URL
 * / deeper inspection and are deferred. macOS process detection is metadata
 * (which app is frontmost), consistent with the privacy contract.
 */

const MEETING_BUNDLES = new Set([
  'us.zoom.xos',
  'com.microsoft.teams',
  'com.microsoft.teams2',
  'com.cisco.webexmeetingsapp',
  'com.webex.meetingmanager',
  'com.google.meet', // Meet PWA
]);

const MEETING_NAME_HINTS = ['zoom', 'microsoft teams', 'teams', 'webex', 'google meet'];

export function isMeetingApp(name?: string | null, bundleId?: string | null): boolean {
  if (bundleId && MEETING_BUNDLES.has(bundleId.toLowerCase())) return true;
  if (name) {
    const n = name.toLowerCase();
    return MEETING_NAME_HINTS.some((h) => n.includes(h));
  }
  return false;
}

/**
 * Debounced enter/exit so a brief focus switch away from the call doesn't end
 * the meeting. Enter is immediate; exit needs `exitGrace` consecutive non-meeting
 * samples (e.g. with a 10s poll, grace 3 ≈ 30s).
 */
export class MeetingTracker {
  private inMeeting = false;
  private misses = 0;

  constructor(private readonly exitGrace = 3) {}

  /** Feed one observation; returns the current state and whether it just changed. */
  update(meetingNow: boolean): { inMeeting: boolean; changed: boolean } {
    if (meetingNow) {
      this.misses = 0;
      if (!this.inMeeting) {
        this.inMeeting = true;
        return { inMeeting: true, changed: true };
      }
      return { inMeeting: true, changed: false };
    }
    if (this.inMeeting) {
      this.misses += 1;
      if (this.misses >= this.exitGrace) {
        this.inMeeting = false;
        this.misses = 0;
        return { inMeeting: false, changed: true };
      }
      return { inMeeting: true, changed: false };
    }
    return { inMeeting: false, changed: false };
  }

  isInMeeting(): boolean {
    return this.inMeeting;
  }
}
