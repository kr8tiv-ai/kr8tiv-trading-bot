import { createHash } from "node:crypto";

/**
 * Deterministic idempotency key for a (signal, approval) pair.
 *
 * Spec per 02-RESEARCH.md Pattern 7:
 *   newClientOrderId = sha256(`${signalId}:${approvalTsMs}`).digest('hex').slice(0, 32)
 *
 * Matches PITFALLS.md Pitfall 5 + EXEC-02 + VPS-04 precedent: MEXC will reject
 * any re-submission with the same newClientOrderId as a duplicate, providing
 * the server-side idempotency guarantee. The hash is deterministic, so a
 * process crash mid-submission is safe — on restart, the PEL replay recomputes
 * the same key and MEXC rejects the duplicate (we XACK and move on).
 *
 * 32 hex chars = 128 bits of entropy (collision probability negligible at any
 * realistic order volume). MEXC does not publish a max-length constraint; 32
 * is empirically safe per research (Pattern 7 Open Question — fallback path
 * documented there in case the live D-04 proof surfaces a shorter ceiling).
 */
export function makeClientOrderId(signalId: string, approvalTsMs: number): string {
  const input = `${signalId}:${approvalTsMs}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}
