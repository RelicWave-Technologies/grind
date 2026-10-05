import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = () => void;
const created: Array<{ handlers: Map<string, Handler>; show: ReturnType<typeof vi.fn> }> = [];

vi.mock('electron', () => ({
  Notification: Object.assign(
    vi.fn(() => {
      const handlers = new Map<string, Handler>();
      const instance = { handlers, on: (event: string, fn: Handler) => handlers.set(event, fn), show: vi.fn() };
      created.push(instance);
      return instance;
    }),
    { isSupported: () => true },
  ),
}));

const { showNotification, retainedNotificationCountForTests } = await import('./notifications');

beforeEach(() => {
  created.length = 0;
});

describe('showNotification', () => {
  it('keeps the notification alive until it is clicked, so the click still works', () => {
    const onClick = vi.fn();
    const before = retainedNotificationCountForTests();

    showNotification({ title: 't', body: 'b' }, onClick);
    expect(retainedNotificationCountForTests()).toBe(before + 1);

    created[0]!.handlers.get('click')!();
    expect(onClick).toHaveBeenCalledOnce();
    expect(retainedNotificationCountForTests()).toBe(before);
  });

  it('lets go of a closed notification and bounds the rest', () => {
    showNotification({ title: 't', body: 'b' });
    const afterOne = retainedNotificationCountForTests();
    created[0]!.handlers.get('close')!();
    expect(retainedNotificationCountForTests()).toBe(afterOne - 1);

    for (let i = 0; i < 50; i += 1) showNotification({ title: 't', body: String(i) });
    expect(retainedNotificationCountForTests()).toBeLessThanOrEqual(20);
  });
});
