/**
 * Proves the OpenAI-compatible adapter works against a real provider.
 *
 * Run:  node --experimental-strip-types scripts/verify-llm.ts
 *
 * Reads LLM_API_KEY / LLM_BASE_URL / LLM_MODEL from the process environment so
 * no key is ever written to a file in this repo. Exercises src/domain/llm.ts,
 * the same module the Worker uses, then runs the real linter over the result.
 */
import { selectClaims, type ClaimOffer } from '../src/domain/llm.ts';
import { lint, type Segment } from '../src/domain/lint.ts';

const BASE = process.env.LLM_BASE_URL ?? 'https://api.x.ai/v1';
const MODEL = process.env.LLM_MODEL ?? 'grok-3-mini';
const KEY = process.env.LLM_API_KEY ?? '';

if (!KEY) {
  console.error('LLM_API_KEY not set in the environment.');
  process.exit(2);
}

const CLAIMS: ClaimOffer[] = [
  { id: 'CLM-001', claim_type: 'efficacy',   claim_text: 'In a 24-week trial, VERIDANE reduced the primary endpoint score by 4.2 points versus 1.8 with placebo.' },
  { id: 'CLM-002', claim_type: 'indication', claim_text: 'VERIDANE is indicated for moderate to severe disease in adults who have had an inadequate response to first-line therapy.' },
  { id: 'CLM-003', claim_type: 'safety',     claim_text: 'The most common adverse reactions were headache (12%), nausea (9%) and fatigue (7%).' },
  { id: 'CLM-004', claim_type: 'safety',     claim_text: 'WARNING: RISK OF SERIOUS INFECTION. Discontinue VERIDANE if a serious infection develops. See full Prescribing Information.' },
  { id: 'CLM-005', claim_type: 'efficacy',   claim_text: 'Response was maintained through 52 weeks in the open-label extension.' },
];

const PROMPT = `You arrange pre-approved claims into promotional copy.

RULES
1. You may ONLY output claims from the CLAIMS list, copied VERBATIM. Never paraphrase, merge, split or reword a claim.
2. Output every claim whose type is "safety". These are required.
3. Do not add transitions, headlines, calls to action, or any sentence of your own.
4. You are choosing ORDER and SELECTION only. You are not an author.
5. Return JSON: {"segments":[{"claim_id":"CLM-XXX"}]} and nothing else.

A sentence you invent cannot be substantiated, so it cannot be approved. Selecting and ordering approved claims is the whole task.`;

const call = await selectClaims(
  { baseUrl: BASE, apiKey: KEY, model: MODEL, temperature: 0 },
  PROMPT,
  'Short launch email for specialists. Lead with the indication.',
  'email',
  CLAIMS,
);

console.log(`provider   : ${BASE}`);
console.log(`model      : ${MODEL}`);
console.log(`finish     : ${call.finishReason}`);
console.log(`usage      : ${JSON.stringify(call.usage)}`);
console.log(`selected   : ${JSON.stringify(call.claimIds)}`);

const byId = new Map(CLAIMS.map((c) => [c.id, c]));
const segments: Segment[] = call.claimIds.map((id, i) => ({
  ordinal: i + 1,
  text: byId.get(id)?.claim_text ?? `[unresolved ${id}]`,
  claimId: byId.has(id) ? id : null,
}));

const result = lint({
  segments,
  allowedClaimIds: CLAIMS.map((c) => c.id),
  requiredSafetyClaimIds: CLAIMS.filter((c) => c.claim_type === 'safety').map((c) => c.id),
  claimTextById: Object.fromEntries(CLAIMS.map((c) => [c.id, c.claim_text])),
});

console.log(`\nassembled  :`);
for (const s of segments) console.log(`  ${s.ordinal}. [${s.claimId}] ${s.text.slice(0, 72)}`);
console.log(`\nlint       : ${result.status.toUpperCase()}`);
for (const f of result.findings) console.log(`  ${f.severity}: ${f.rule} - ${f.message}`);

process.exit(result.status === 'pass' && segments.length > 0 ? 0 : 1);
