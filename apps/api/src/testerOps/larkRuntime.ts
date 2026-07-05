import { isLarkConfigured } from '../lark/config';
import { HttpLarkMessenger, type LarkMessenger } from '../lark/messenger';

let messenger: LarkMessenger | null = null;
let override: LarkMessenger | null = null;

export function getTesterOpsLarkMessenger(): LarkMessenger | null {
  if (override) return override;
  if (!isLarkConfigured()) return null;
  if (!messenger) messenger = new HttpLarkMessenger();
  return messenger;
}

export function setTesterOpsLarkMessengerForTests(next: LarkMessenger | null): void {
  override = next;
}

