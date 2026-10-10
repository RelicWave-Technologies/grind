import { Notification } from 'electron';

/**
 * A Notification with nothing referencing it is garbage-collected after
 * show(), and its click handler goes with it: clicking "Timo update ready" in
 * Notification Center later did nothing. Hold each one until it is clicked or
 * closed. Bounded, so notifications that never report back cannot pile up.
 */
const MAX_RETAINED = 20;
const retained = new Set<Notification>();

export function showNotification(
  options: { title: string; body: string },
  onClick?: () => void,
): boolean {
  if (!Notification.isSupported()) return false;
  const notification = new Notification(options);
  const release = () => {
    retained.delete(notification);
  };
  retained.add(notification);
  if (retained.size > MAX_RETAINED) {
    const oldest = retained.values().next().value;
    if (oldest) retained.delete(oldest);
  }
  notification.on('click', () => {
    release();
    onClick?.();
  });
  notification.on('close', release);
  notification.on('failed', release);
  notification.show();
  return true;
}

export function retainedNotificationCountForTests(): number {
  return retained.size;
}
