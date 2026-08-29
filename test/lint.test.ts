import { describe, it, expect } from 'vitest';
import { lint, type Segment } from '../src/domain/lint';

const CLAIM_TEXT: Record<string, string> = {
  'CLM-001': 'In a 24-week trial, VERIDANE reduced the primary endpoint score by 4.2 points versus 1.8 with placebo.',
  'CLM-003': 'The most common adverse reactions were headache (12%), nausea (9%) and fatigue (7%).',
  'CLM-004': 'WARNING: RISK OF SERIOUS INFECTION. Discontinue VERIDANE if a serious infection develops. See full Prescribing Information.',
  'CLM-005': 'Response was maintained through 52 weeks in the open-label extension.',
};
const ALLOWED = Object.keys(CLAIM_TEXT);
const SAFETY = ['CLM-003', 'CLM-004'];

function run(segments: Segment[]) {
  return lint({
    segments,
    allowedClaimIds: ALLOWED,
    requiredSafetyClaimIds: SAFETY,
    claimTextById: CLAIM_TEXT,
  });
}

const seg = (ordinal: number, claimId: string, text?: string): Segment => ({
  ordinal,
  claimId,
  text: text ?? CLAIM_TEXT[claimId],
});

describe('deterministic compliance linter', () => {
  it('passes a well-formed artifact with both safety claims present', () => {
    const r = run([seg(1, 'CLM-004'), seg(2, 'CLM-001'), seg(3, 'CLM-003')]);
    expect(r.status).toBe('pass');
    expect(r.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('fails an artifact containing an unlinked segment', () => {
    const r = run([
      seg(1, 'CLM-004'),
      { ordinal: 2, text: 'VERIDANE is the smart choice for your patients.', claimId: null },
      seg(3, 'CLM-003'),
    ]);
    expect(r.status).toBe('fail');
    expect(r.findings.some((f) => f.rule === 'unlinked-segment')).toBe(true);
  });

  it('fails when a required safety claim is missing', () => {
    const r = run([seg(1, 'CLM-001'), seg(2, 'CLM-005'), seg(3, 'CLM-003')]);
    expect(r.status).toBe('fail');
    const missing = r.findings.find((f) => f.rule === 'missing-safety-claim');
    expect(missing?.message).toContain('CLM-004');
  });

  it('fails when a claim was reworded rather than reproduced verbatim', () => {
    const r = run([
      seg(1, 'CLM-004'),
      seg(2, 'CLM-001', 'VERIDANE cut the endpoint score by well over twice as much as placebo.'),
      seg(3, 'CLM-003'),
    ]);
    expect(r.status).toBe('fail');
    expect(r.findings.some((f) => f.rule === 'claim-text-altered')).toBe(true);
  });

  it('fails on a claim ID that was never offered (model invented or recalled it)', () => {
    const r = run([
      seg(1, 'CLM-004'),
      { ordinal: 2, text: 'VERIDANE is well tolerated.', claimId: 'CLM-999' },
      seg(3, 'CLM-003'),
    ]);
    expect(r.status).toBe('fail');
    expect(r.findings.some((f) => f.rule === 'claim-out-of-scope')).toBe(true);
  });

  it('catches unsupported comparative language', () => {
    for (const bad of [
      'VERIDANE is more effective than competitor therapy.',
      'VERIDANE is the best option available.',
      'VERIDANE outperforms standard of care.',
      'Unlike other therapies, VERIDANE works quickly.',
    ]) {
      const r = run([seg(1, 'CLM-004'), { ordinal: 2, text: bad, claimId: 'CLM-001' }, seg(3, 'CLM-003')]);
      expect(r.findings.some((f) => f.rule === 'unsupported-comparative'), bad).toBe(true);
    }
  });

  it('catches absolute efficacy and safety language', () => {
    for (const bad of [
      'VERIDANE cures the condition.',
      'VERIDANE is completely safe.',
      'VERIDANE has no side effects.',
      'VERIDANE is 100% effective.',
    ]) {
      const r = run([seg(1, 'CLM-004'), { ordinal: 2, text: bad, claimId: 'CLM-001' }, seg(3, 'CLM-003')]);
      expect(r.findings.some((f) => f.rule === 'absolute-language'), bad).toBe(true);
    }
  });

  it('warns when risk information is buried in the back half', () => {
    const r = run([
      seg(1, 'CLM-001'),
      seg(2, 'CLM-005'),
      seg(3, 'CLM-001'),
      seg(4, 'CLM-004'),
      seg(5, 'CLM-003'),
    ]);
    expect(r.findings.some((f) => f.rule === 'safety-not-prominent')).toBe(true);
  });

  it('fails an empty artifact rather than passing it vacuously', () => {
    expect(run([]).status).toBe('fail');
  });

  it('is deterministic: identical input yields an identical verdict', () => {
    const input = [seg(1, 'CLM-004'), seg(2, 'CLM-001'), seg(3, 'CLM-003')];
    const a = JSON.stringify(run(input));
    for (let i = 0; i < 25; i++) expect(JSON.stringify(run(input))).toBe(a);
  });
});
