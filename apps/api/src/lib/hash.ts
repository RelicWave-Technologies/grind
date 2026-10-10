import { createHash } from 'node:crypto';

/** Hex SHA-256 of a UTF-8 string — how every token, code and payload hash here is stored. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
