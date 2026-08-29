import { describe, it, expect } from 'vitest';
import { hashEntry, verifyChain, type AuditInput, type AuditRow } from '../src/domain/audit';
import { parseClaimIds } from '../src/domain/llm';

async function chain(inputs: Array<AuditInput & { at: string }>): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  let prev: string | null = null;
  let seq = 1;
  for (const i of inputs) {
    const entryHash = await hashEntry(i, i.at, prev);
    rows.push({ ...i, seq: seq++, prevHash: prev, entryHash });
    prev = entryHash;
  }
  return rows;
}

const SAMPLE: Array<AuditInput & { at: string }> = [
  { artifactId: 'ART-1', eventType: 'created', actor: 'ariel', at: '2026-08-28 10:00:00', toState: 'draft' },
  {
    artifactId: 'ART-1',
    eventType: 'generated',
    actor: 'system:generator',
    at: '2026-08-28 10:01:00',
    fromState: 'draft',
    toState: 'generated',
    promptVersion: 'assemble@2',
    modelId: 'gpt-4o-mini-2024-07-18',
    temperature: '0',
    request: { messages: [{ role: 'user', content: 'brief' }] },
    response: { choices: [{ message: { content: '{"segments":[{"claim_id":"CLM-001"}]}' } }] },
  },
  {
    artifactId: 'ART-1',
    eventType: 'approved',
    actor: 'reviewer@example.com',
    at: '2026-08-28 10:05:00',
    fromState: 'in_review',
    toState: 'approved',
  },
];

describe('append-only hash-chained audit trail', () => {
  it('verifies an untampered chain', async () => {
    expect(await verifyChain(await chain(SAMPLE))).toEqual({ ok: true });
  });

  it('detects an altered historical entry', async () => {
    const rows = await chain(SAMPLE);
    // Someone quietly rewrites who approved it.
    rows[2].actor = 'someone.else@example.com';
    const v = await verifyChain(rows);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.brokenAtSeq).toBe(3);
  });

  it('detects a deleted entry', async () => {
    const rows = await chain(SAMPLE);
    const v = await verifyChain([rows[0], rows[2]]);
    expect(v.ok).toBe(false);
  });

  it('detects a tampered generation record (prompt or model swapped after the fact)', async () => {
    const rows = await chain(SAMPLE);
    rows[1].modelId = 'some-other-model';
    const v = await verifyChain(rows);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.brokenAtSeq).toBe(2);
  });

  it('hashes are stable regardless of property insertion order', async () => {
    const a: AuditInput = { artifactId: 'A', eventType: 'e', actor: 'x', request: { b: 1, a: 2 } };
    const b: AuditInput = { artifactId: 'A', eventType: 'e', actor: 'x', request: { a: 2, b: 1 } };
    expect(await hashEntry(a, 't', null)).toBe(await hashEntry(b, 't', null));
  });
});

describe('LLM response parsing (fails safe)', () => {
  it('parses a well-formed selection', () => {
    expect(parseClaimIds('{"segments":[{"claim_id":"CLM-004"},{"claim_id":"CLM-001"}]}')).toEqual([
      'CLM-004',
      'CLM-001',
    ]);
  });

  it('recovers JSON wrapped in a fenced code block', () => {
    expect(parseClaimIds('```json\n{"segments":[{"claim_id":"CLM-002"}]}\n```')).toEqual(['CLM-002']);
  });

  it('returns an empty selection for junk rather than throwing or guessing', () => {
    for (const junk of ['', 'I cannot help with that.', '{"nope":1}', '{"segments":"CLM-001"}']) {
      expect(parseClaimIds(junk)).toEqual([]);
    }
  });

  it('drops anything that is not a well-formed claim ID', () => {
    expect(
      parseClaimIds('{"segments":[{"claim_id":"CLM-001"},{"claim_id":"DROP TABLE claims"},{"claim_id":42}]}'),
    ).toEqual(['CLM-001']);
  });
});
