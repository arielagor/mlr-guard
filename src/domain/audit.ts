/**
 * Append-only, hash-chained audit trail.
 *
 * A log you can quietly edit is not an audit trail. Each entry commits to the
 * previous entry's hash, so removing or altering a historical event breaks the
 * chain and `verifyChain` will say where. That is a cheap property to add and
 * it is the difference between "we have logs" and "we can show a reviewer what
 * happened".
 *
 * The traditional audit-trail model assumes the same input produces the same
 * output. LLMs break that assumption, so recording the final value is not
 * enough: each generation event stores the prompt VERSION, the pinned model ID,
 * the sampling temperature, and the full request and response. That is what
 * makes a non-deterministic step reconstructable after the fact.
 */

export interface AuditInput {
  artifactId: string;
  eventType: string;
  actor: string;
  fromState?: string | null;
  toState?: string | null;
  promptVersion?: string | null;
  modelId?: string | null;
  temperature?: string | null;
  request?: unknown;
  response?: unknown;
  detail?: string | null;
  snapshotKey?: string | null;
}

export interface AuditRow extends AuditInput {
  seq: number;
  at: string;
  prevHash: string | null;
  entryHash: string;
}

/** SHA-256 over the canonical serialisation of the entry plus the previous hash. */
export async function hashEntry(
  input: AuditInput,
  at: string,
  prevHash: string | null,
): Promise<string> {
  const canonical = JSON.stringify([
    prevHash ?? '',
    input.artifactId,
    input.eventType,
    input.actor,
    at,
    input.fromState ?? '',
    input.toState ?? '',
    input.promptVersion ?? '',
    input.modelId ?? '',
    input.temperature ?? '',
    stableStringify(input.request),
    stableStringify(input.response),
    input.detail ?? '',
    input.snapshotKey ?? '',
  ]);
  return sha256Hex(canonical);
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Recompute the chain and report the first entry that does not match.
 * Exposed on the API so the property is demonstrable, not just claimed.
 */
export async function verifyChain(
  rows: Array<AuditRow & { at: string }>,
): Promise<{ ok: true } | { ok: false; brokenAtSeq: number; reason: string }> {
  let prev: string | null = null;
  for (const row of rows) {
    if ((row.prevHash ?? null) !== prev) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: `prev_hash mismatch: entry claims ${row.prevHash ?? 'null'}, chain expects ${prev ?? 'null'}`,
      };
    }
    const expected = await hashEntry(row, row.at, prev);
    if (expected !== row.entryHash) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: 'entry_hash does not match the recomputed hash; this entry was altered',
      };
    }
    prev = row.entryHash;
  }
  return { ok: true };
}

/** Key-sorted JSON so hashing is stable regardless of property insertion order. */
function stableStringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  const seen = new WeakSet<object>();
  const walk = (x: any): any => {
    if (x === null || typeof x !== 'object') return x;
    if (seen.has(x)) return '[circular]';
    seen.add(x);
    if (Array.isArray(x)) return x.map(walk);
    return Object.keys(x)
      .sort()
      .reduce((acc: Record<string, any>, k) => {
        acc[k] = walk(x[k]);
        return acc;
      }, {});
  };
  return JSON.stringify(walk(v));
}
