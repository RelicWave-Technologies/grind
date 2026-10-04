/**
 * What a surface tells the gallery around it (window.parent.postMessage). These
 * stand in for things the real main process does to WINDOWS rather than to
 * state: hiding a prompt after it is answered, bringing the main window
 * forward, opening System Settings or a browser. A surface opened alone has no
 * gallery, so it only logs them to the console.
 */
export const LAB_MESSAGE_SOURCE = 'timo-agent-lab';

export type LabFrameMessage =
  /** Something outside the app would happen (browser opens, macOS prompt, quit). */
  | { source: typeof LAB_MESSAGE_SOURCE; type: 'effect'; frame: string; text: string }
  /** This surface's window would be hidden / shown again. */
  | { source: typeof LAB_MESSAGE_SOURCE; type: 'window'; frame: string; action: 'hide' | 'show'; note?: string }
  /** Another window would come to the front. */
  | { source: typeof LAB_MESSAGE_SOURCE; type: 'focus'; frame: string; target: 'main' | 'permission' }
  /** An uncaught error or rejection inside the surface (renderer or lab). */
  | { source: typeof LAB_MESSAGE_SOURCE; type: 'error'; frame: string; text: string };

type Payload = LabFrameMessage extends infer M ? (M extends LabFrameMessage ? Omit<M, 'source' | 'frame'> : never) : never;

export function isLabFrameMessage(data: unknown): data is LabFrameMessage {
  return typeof data === 'object' && data !== null && (data as { source?: unknown }).source === LAB_MESSAGE_SOURCE;
}

export function tellGallery(frame: string, payload: Payload): void {
  const message = { source: LAB_MESSAGE_SOURCE, frame, ...payload } as LabFrameMessage;
  if (window.parent !== window) {
    window.parent.postMessage(message, window.location.origin);
  } else if (payload.type !== 'error') {
    console.info('[agent-lab]', payload);
  }
}
