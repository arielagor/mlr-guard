/**
 * The deterministic compliance linter.
 *
 * These checks are DELIBERATELY not done by an LLM. A model asked "is the
 * safety information adequately presented?" gives a fluent, plausible, and
 * occasionally wrong answer, and it gives a different answer on Tuesday. Every
 * rule here is a property you can decide by looking at the structure of the
 * artifact, so it should be decided by code that returns the same verdict every
 * time and can be unit-tested.
 *
 * Judgement calls that genuinely need a human still go to a human. The linter
 * exists to make sure the human is never spending their attention on something
 * mechanically checkable.
 */

export interface Segment {
  ordinal: number;
  text: string;
  claimId: string | null;
  claimType?: string | null;
}

export type Severity = 'error' | 'warn';

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  ordinal?: number;
}

export interface LintResult {
  status: 'pass' | 'fail';
  findings: Finding[];
}

/** Comparative language that requires a head-to-head claim to substantiate it. */
const COMPARATIVE_PATTERNS: readonly RegExp[] = [
  /\b(more|less)\s+(effective|efficacious|potent|tolerable|powerful)\b/i,
  /\b(better|worse|superior|inferior|safer|stronger|faster)\s+than\b/i,
  /\b(best|safest|strongest|fastest|most\s+effective|number\s+one|#1)\b/i,
  /\boutperform(s|ed|ing)?\b/i,
  /\bunlike\s+(other|competing|competitor)/i,
];

/** Absolutes that overstate what any label supports. */
const ABSOLUTE_PATTERNS: readonly RegExp[] = [
  /\b(cures?|curing|eliminates?|guarantee[sd]?|100%\s+effective|completely\s+safe|no\s+side\s+effects)\b/i,
  /\b(always|never)\s+works\b/i,
];

export interface LintInput {
  segments: Segment[];
  /** Claim IDs that were offered to the model, i.e. approved and in scope. */
  allowedClaimIds: readonly string[];
  /** Claim IDs whose type is 'safety'. All of these must appear. */
  requiredSafetyClaimIds: readonly string[];
  /** Verbatim text of each allowed claim, for the tamper check. */
  claimTextById: Readonly<Record<string, string>>;
}

export function lint(input: LintInput): LintResult {
  const { segments, allowedClaimIds, requiredSafetyClaimIds, claimTextById } = input;
  const findings: Finding[] = [];
  const allowed = new Set(allowedClaimIds);

  if (segments.length === 0) {
    findings.push({ rule: 'empty', severity: 'error', message: 'Artifact has no content.' });
  }

  for (const seg of segments) {
    // R1. Provenance. An unlinked sentence has nothing substantiating it, so it
    // cannot be reviewed, so it cannot ship. This is the core rule.
    if (!seg.claimId) {
      findings.push({
        rule: 'unlinked-segment',
        severity: 'error',
        ordinal: seg.ordinal,
        message: 'Segment is not linked to an approved claim.',
      });
      continue;
    }

    // R2. In-scope. Catches a model that invented or recalled a claim ID that
    // was never offered to it for this product/audience.
    if (!allowed.has(seg.claimId)) {
      findings.push({
        rule: 'claim-out-of-scope',
        severity: 'error',
        ordinal: seg.ordinal,
        message: `Segment cites ${seg.claimId}, which is not an approved claim for this product and audience.`,
      });
      continue;
    }

    // R3. Verbatim. The model's job is selection and order, not wording. If the
    // rendered text drifts from the approved claim text, the approval no longer
    // covers what is on the page.
    const approvedText = claimTextById[seg.claimId];
    if (approvedText && normalise(seg.text) !== normalise(approvedText)) {
      findings.push({
        rule: 'claim-text-altered',
        severity: 'error',
        ordinal: seg.ordinal,
        message: `Segment text does not match the approved wording of ${seg.claimId} verbatim.`,
      });
    }

    // R4/R5. Language checks on whatever actually made it onto the page.
    for (const re of COMPARATIVE_PATTERNS) {
      if (re.test(seg.text)) {
        findings.push({
          rule: 'unsupported-comparative',
          severity: 'error',
          ordinal: seg.ordinal,
          message:
            'Comparative language requires a head-to-head claim; none is linked to this segment.',
        });
        break;
      }
    }
    for (const re of ABSOLUTE_PATTERNS) {
      if (re.test(seg.text)) {
        findings.push({
          rule: 'absolute-language',
          severity: 'error',
          ordinal: seg.ordinal,
          message: 'Absolute or unqualified efficacy/safety language.',
        });
        break;
      }
    }
  }

  // R6. Required safety content is present.
  const present = new Set(segments.map((s) => s.claimId).filter(Boolean) as string[]);
  for (const required of requiredSafetyClaimIds) {
    if (!present.has(required)) {
      findings.push({
        rule: 'missing-safety-claim',
        severity: 'error',
        message: `Required safety claim ${required} is missing from the artifact.`,
      });
    }
  }

  // R7. Prominence. Risk information that is technically present but buried at
  // the end after a long run of efficacy copy is the classic fair-balance
  // failure. We check position, which is structural and therefore checkable.
  const safetyOrdinals = segments
    .filter((s) => s.claimId && requiredSafetyClaimIds.includes(s.claimId))
    .map((s) => s.ordinal);
  if (safetyOrdinals.length > 0 && segments.length >= 4) {
    const firstSafety = Math.min(...safetyOrdinals);
    // 1-based position of the first safety claim among the rendered segments.
    const position = segments.findIndex((s) => s.ordinal === firstSafety) + 1;
    if (position > segments.length / 2) {
      findings.push({
        rule: 'safety-not-prominent',
        severity: 'warn',
        ordinal: firstSafety,
        message:
          'First safety claim appears in the back half of the artifact. Risk information should be comparably prominent to benefit information.',
      });
    }
  }

  return {
    status: findings.some((f) => f.severity === 'error') ? 'fail' : 'pass',
    findings,
  };
}

function normalise(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim()
    .toLowerCase();
}
