/**
 * Pure visibility policy for the floating timer bar.
 *
 * Timer state, the persistent Settings preference, and a one-session dismiss
 * are deliberately separate. A pause keeps the same active entry and therefore
 * keeps the bar visible. Dismiss hides only that entry; the next entry gets a
 * fresh bar automatically.
 */
export class FloatingBarVisibilityPolicy {
  private activeEntryId: string | null = null;
  private dismissedEntryId: string | null = null;
  private preferenceVisible = true;

  syncTimer(entryId: string | null, preferenceVisible: boolean): boolean {
    this.preferenceVisible = preferenceVisible;
    if (entryId !== this.activeEntryId) {
      this.activeEntryId = entryId;
      if (entryId !== this.dismissedEntryId) this.dismissedEntryId = null;
    }
    return this.shouldShow();
  }

  dismissCurrent(): boolean {
    this.dismissedEntryId = this.activeEntryId;
    return this.shouldShow();
  }

  setPreferenceVisible(visible: boolean): boolean {
    this.preferenceVisible = visible;
    if (visible) this.dismissedEntryId = null;
    return this.shouldShow();
  }

  private shouldShow(): boolean {
    return this.preferenceVisible
      && this.activeEntryId !== null
      && this.activeEntryId !== this.dismissedEntryId;
  }
}
