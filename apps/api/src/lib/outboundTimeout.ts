/**
 * One bound for every outbound call to Lark / GitHub.
 *
 * Node's fetch has no default timeout: a peer that accepts the connection and
 * then never answers parks the request — and whatever awaits it (a scheduler
 * tick, a request handler, an outbox claim) — forever. The signal also covers
 * reading the body, so a response that stalls half-way is cut off too.
 */
export const OUTBOUND_TIMEOUT_MS = 15_000;

export function outboundTimeoutSignal(ms: number = OUTBOUND_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}
