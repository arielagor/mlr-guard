# mlr-guard

**Claims-grounded content generation on the Cloudflare edge.** An LLM assembles promotional copy
from a library of pre-approved claims. It never writes a sentence, every sentence carries the claim
and reference that substantiate it, and nothing reaches `published` without an authenticated human
approval.

Vue 3 + TypeScript · Hono on Cloudflare Workers · D1 · R2 · OpenAI-compatible LLM API

**Live: https://mlr-guard.ariel-ec1.workers.dev**

> **This is a demo built for a job application, on a fictional product with synthetic claims.**
> "VERIDANE" does not exist. The studies and prescribing information referenced are invented. There
> is no real drug, no real claim, no real trial and no patient data anywhere in this repository.
> It is not a regulatory tool and must not be used as one.

---

## The problem it takes seriously

If you point a language model at pharmaceutical marketing copy, the model is not the hard part. The
hard part is that the output has to survive Medical/Legal/Regulatory review, and a reviewer cannot
approve a sentence that nothing substantiates.

Two properties follow, and both of them are structural rather than advisory:

1. **The model selects, it does not author.** It is given approved claims and returns claim *IDs*.
   The text rendered on the page is read back out of the claims library, so a claim cannot be
   reworded in transit even if the model tries. What it chooses is order and selection.
2. **A human approval is a property of the state machine, not a step in a runbook.** There is no
   sequence of API calls that reaches `published` without an authenticated person having approved
   it. A test asserts this by exhaustively exploring every reachable state using machine identity
   only and confirming `approved` and `published` are unreachable.

Everything else here is ordinary engineering. Those two are the point.

## What is in the box

| Piece | File | What it does |
|---|---|---|
| Approval state machine | `src/domain/state.ts` | One choke point for every state change. Fails closed. Refuses human-only transitions from anonymous or machine identities. |
| Deterministic compliance linter | `src/domain/lint.ts` | Seven rules, no LLM. Provenance, in-scope claim, verbatim text, comparative language, absolute language, required safety claims, and prominence of risk information. |
| OpenAI-compatible LLM client | `src/domain/llm.ts` | Raw wire format, so the same code runs against OpenAI, xAI, Azure OpenAI, an AI Gateway or a self-hosted endpoint. Parses defensively: a malformed reply yields an empty selection, which fails the linter, rather than a partial asset. |
| Hash-chained audit trail | `src/domain/audit.ts` | Append-only. Each entry commits to the previous entry's hash, so an alteration or a deletion is detectable and `verifyChain` reports where. |
| API | `src/api/index.ts` | Hono. One endpoint per transition. There is deliberately no general-purpose "update artifact" route. |
| Console | `web/` | Vue 3 Composition API. Shows the claim, citation and anchor under every sentence. |

### Why the audit trail records so much

A conventional audit trail assumes that the same input produces the same output, so recording the
final value is enough. An LLM breaks that assumption. So each generation event stores the **prompt
version**, the **pinned model ID**, the **sampling temperature**, and the **full request and
response**. Approval events store the identity of the human and the content-addressed snapshot key
of exactly what they were looking at.

Prompts are rows in `prompt_versions`, not strings edited in the codebase. `assemble@1` is kept in
the seed data specifically so you can see that an older generation's record still resolves after the
prompt has moved on.

### Why the linter is not an LLM

Every rule in `lint.ts` is decidable by looking at the structure of the artifact. Asking a model
"is the safety information adequately presented?" produces a fluent, plausible answer that can be
wrong and can differ between runs. `safety-not-prominent` is a position check. `missing-safety-claim`
is a set difference. `claim-text-altered` is a string comparison against the approved record. These
should be code, and code is testable: `test/lint.test.ts` includes a test asserting the linter
returns an identical verdict 25 times for identical input.

Judgement that genuinely needs a person still goes to a person. The linter exists so the person is
never spending attention on something mechanically checkable.

## Run it

```bash
npm install
npx wrangler d1 create mlr_guard          # paste database_id into wrangler.toml
npm run db:local                          # schema + synthetic seed
npm run build                             # build the Vue console
npx wrangler dev                          # http://127.0.0.1:8787
```

Without an LLM key the app still runs end to end: generation falls back to a deterministic
selection, and the audit trail records it as exactly that (`offline-fallback`), so the governance
path stays demonstrable without a provider account.

To use a real model, put the key in `.dev.vars` (gitignored):

```
LLM_API_KEY=sk-...
```

and point `LLM_BASE_URL` / `LLM_MODEL` in `wrangler.toml` at any OpenAI-compatible endpoint. It has
been exercised against `api.x.ai/v1` and `api.openai.com/v1`.

```bash
npm test           # 28 tests
npm run typecheck  # worker + web
```

`scripts/verify-llm.ts` calls a live provider and runs the linter over the result, outside the
Worker, so the adapter can be checked independently:

```bash
LLM_API_KEY=... node --experimental-strip-types scripts/verify-llm.ts
```

## Deploy

```bash
wrangler login
wrangler d1 create mlr_guard              # put the id in wrangler.toml
wrangler r2 bucket create mlr-guard-snapshots
npm run db:remote
wrangler secret put LLM_API_KEY
npm run deploy
```

## Proving the gate

```bash
# publish straight from 'generated', skipping review
curl -X POST localhost:8787/api/artifacts/$ID/publish -H 'x-actor: someone@example.com'
# -> 409 illegal transition: generated --publish--> (none)

# approve with no identity
curl -X POST localhost:8787/api/artifacts/$ID/approve
# -> 409 approve requires an authenticated human actor

# approve as the generator itself
curl -X POST localhost:8787/api/artifacts/$ID/approve -H 'x-actor: system:generator'
# -> 409 approve cannot be performed by a machine identity (system:generator)

# verify the audit chain
curl localhost:8787/api/artifacts/$ID/audit/verify
# -> {"entries":5,"verification":{"ok":true}}
```

## Notes from building it

- **wrangler 3.114 silently drops `.dev.vars`.** The startup banner listed `LLM_API_KEY` as bound
  and `Object.keys(env)` did not contain it, so every generation quietly took the offline fallback
  while looking like it had a key. wrangler 4.127 binds it correctly. The `llmConfigured` field on
  `/api/health` exists because of this: it makes "am I getting real generations?" answerable without
  reading logs.
- **The hash chain is global, not per-artifact.** That is the stronger property, because deleting an
  artifact's entire history is then detectable too. It does mean verification has to run over the
  whole log; verifying a single artifact's slice reports a false break at its first entry, since
  that entry's `prev_hash` legitimately points at a different artifact's event.
- **The prominence rule had an off-by-one.** It compared a 0-based index against `ceil(n/2)` and so
  missed a safety claim sitting at position 4 of 5. Caught by a test that encoded the intent rather
  than the implementation.
- **Snapshots degrade gracefully when R2 is absent.** Creating an R2 bucket requires a billing
  subscription, and this project was briefly deployed on an account without one. Rather than let a
  missing object store disable the audit trail, `putSnapshot`/`getSnapshot` prefer R2 when the
  binding is present and fall back to a `snapshots` table in D1 when it is not. Snapshots stay
  content-addressed in both configurations, so "show me exactly what the reviewer approved" holds
  either way. R2 is enabled on the live deployment now; the two artifacts generated before it was
  turned on still resolve, because `getSnapshot` falls through to D1 on an R2 miss.
- **`wrangler r2 object get` defaults to LOCAL storage in wrangler 4.** It reported "The specified
  key does not exist" for an object that production was serving fine. Pass `--remote` to query the
  real bucket. Same class of trap as `d1 execute`, and it will make you doubt a working system.

## Not built here

Real SSO (the `x-actor` header stands in for OIDC/SAML), the DAM integration that would push an
approved asset into a system of record and start the review workflow there, modular content and
reusable pre-approved blocks, and reviewer annotations. The scope was the governance spine, because
that is the part where being wrong is expensive.

## Licence

MIT.
