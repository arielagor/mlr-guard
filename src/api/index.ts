/**
 * mlr-guard API. Hono on Cloudflare Workers.
 *
 * Route design follows the state machine: each endpoint performs exactly one
 * transition, and every transition writes an audit entry in the same request.
 * There is no "update artifact" endpoint, because a general-purpose mutation
 * route is how state machines get bypassed in practice.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { transition, type ArtifactState, TransitionError } from '../domain/state';
import { lint, type Segment } from '../domain/lint';
import { selectClaims, LlmError, type LlmConfig } from '../domain/llm';
import { hashEntry, sha256Hex, verifyChain, type AuditInput } from '../domain/audit';

export interface Env {
  DB: D1Database;
  SNAPSHOTS: R2Bucket;
  ASSETS: Fetcher;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  LLM_TEMPERATURE: string;
  LLM_API_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();
app.use('/api/*', cors());

/**
 * Demo-grade identity. A real deployment swaps this for the customer's SSO
 * (OIDC/SAML) and keeps the rest of the code unchanged, because everything
 * downstream only asks "who is the authenticated actor, or nobody?".
 *
 * The important property is what happens when this returns null: human-only
 * transitions are refused by the state machine, not merely discouraged.
 */
function actorOf(c: any): string | null {
  const raw = c.req.header('x-actor');
  if (!raw) return null;
  const actor = String(raw).trim();
  return actor.length > 0 ? actor : null;
}

const CURRENT_PROMPT = 'assemble@2';

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'mlr-guard',
    // Surfaced so it is obvious whether a generation was a real model call or
    // the deterministic offline fallback. Never returns the key itself.
    llmConfigured: Boolean(c.env.LLM_API_KEY && c.env.LLM_API_KEY.length > 0),
    llmBaseUrl: c.env.LLM_BASE_URL,
    llmModel: c.env.LLM_MODEL,
    promptVersion: CURRENT_PROMPT,
  }),
);

app.get('/api/claims', async (c) => {
  const product = c.req.query('product') ?? 'VERIDANE';
  const audience = c.req.query('audience') ?? 'hcp';
  const { results } = await c.env.DB.prepare(
    `SELECT cl.id, cl.claim_text, cl.claim_type, cl.status,
            r.id AS reference_id, r.citation, r.anchor
       FROM claims cl
       JOIN reference_docs r ON r.id = cl.reference_id
      WHERE cl.product = ? AND cl.audience = ? AND cl.status = 'approved'
      ORDER BY cl.claim_type = 'safety' DESC, cl.id`,
  )
    .bind(product, audience)
    .all();
  return c.json({ claims: results });
});

app.get('/api/prompt-versions', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, version, body, notes, frozen_at FROM prompt_versions ORDER BY name, version`,
  ).all();
  return c.json({ promptVersions: results, current: CURRENT_PROMPT });
});

app.get('/api/artifacts', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, product, audience, channel, brief, state, lint_status,
            prompt_version, model_id, created_at, updated_at
       FROM artifacts ORDER BY created_at DESC LIMIT 50`,
  ).all();
  return c.json({ artifacts: results });
});

app.get('/api/artifacts/:id', async (c) => {
  const id = c.req.param('id');
  const artifact = await c.env.DB.prepare(`SELECT * FROM artifacts WHERE id = ?`)
    .bind(id)
    .first();
  if (!artifact) return c.json({ error: 'not found' }, 404);

  const { results: segments } = await c.env.DB.prepare(
    `SELECT s.ordinal, s.text, s.claim_id,
            cl.claim_type, r.citation, r.anchor
       FROM artifact_segments s
       LEFT JOIN claims cl ON cl.id = s.claim_id
       LEFT JOIN reference_docs r ON r.id = cl.reference_id
      WHERE s.artifact_id = ? ORDER BY s.ordinal`,
  )
    .bind(id)
    .all();

  const { results: audit } = await c.env.DB.prepare(
    `SELECT seq, event_type, actor, at, from_state, to_state, prompt_version,
            model_id, temperature, detail, snapshot_key, prev_hash, entry_hash
       FROM audit_events WHERE artifact_id = ? ORDER BY seq`,
  )
    .bind(id)
    .all();

  return c.json({ artifact, segments, audit });
});

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

app.post('/api/artifacts', async (c) => {
  const body = await c.req.json<{
    product?: string;
    audience?: string;
    channel?: string;
    brief?: string;
  }>();
  const id = `ART-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const product = body.product ?? 'VERIDANE';
  const audience = body.audience === 'patient' ? 'patient' : 'hcp';
  const channel = body.channel ?? 'email';
  const brief = (body.brief ?? '').trim();
  if (!brief) return c.json({ error: 'brief is required' }, 400);

  await c.env.DB.prepare(
    `INSERT INTO artifacts (id, product, audience, channel, brief, state)
     VALUES (?, ?, ?, ?, ?, 'draft')`,
  )
    .bind(id, product, audience, channel, brief)
    .run();

  await appendAudit(c.env, {
    artifactId: id,
    eventType: 'created',
    actor: actorOf(c) ?? 'anonymous',
    toState: 'draft',
    detail: brief,
  });

  return c.json({ id, state: 'draft' }, 201);
});

/** draft -> generated. Machine step; no human identity required. */
app.post('/api/artifacts/:id/generate', async (c) => {
  const id = c.req.param('id');
  const artifact = await c.env.DB.prepare(`SELECT * FROM artifacts WHERE id = ?`)
    .bind(id)
    .first<any>();
  if (!artifact) return c.json({ error: 'not found' }, 404);

  let next: ArtifactState;
  try {
    next = transition(artifact.state as ArtifactState, 'generate', { actor: actorOf(c) });
  } catch (e) {
    return transitionError(c, e);
  }

  // Only approved, in-scope claims are ever offered to the model.
  const { results: claims } = await c.env.DB.prepare(
    `SELECT id, claim_text, claim_type FROM claims
      WHERE product = ? AND audience = ? AND status = 'approved' ORDER BY id`,
  )
    .bind(artifact.product, artifact.audience)
    .all<{ id: string; claim_text: string; claim_type: string }>();

  const prompt = await c.env.DB.prepare(`SELECT body FROM prompt_versions WHERE id = ?`)
    .bind(CURRENT_PROMPT)
    .first<{ body: string }>();
  if (!prompt) return c.json({ error: `prompt version ${CURRENT_PROMPT} missing` }, 500);

  const cfg: LlmConfig = {
    baseUrl: c.env.LLM_BASE_URL,
    apiKey: c.env.LLM_API_KEY ?? '',
    model: c.env.LLM_MODEL,
    temperature: Number(c.env.LLM_TEMPERATURE ?? '0'),
  };

  let selected: string[];
  let request: unknown = null;
  let response: unknown = null;

  if (!cfg.apiKey) {
    // No key configured: fall back to a deterministic, clearly-labelled
    // selection so the governance path stays demonstrable without a provider.
    // It is recorded in the audit trail as exactly what it is.
    selected = deterministicFallback(claims);
    response = { note: 'offline-fallback: no LLM_API_KEY configured; deterministic selection used' };
  } else {
    try {
      const call = await selectClaims(cfg, prompt.body, artifact.brief, artifact.channel, claims);
      selected = call.claimIds;
      request = call.request;
      response = call.response;
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError(String(e));
      await appendAudit(c.env, {
        artifactId: id,
        eventType: 'generate_failed',
        actor: 'system:generator',
        fromState: artifact.state,
        promptVersion: CURRENT_PROMPT,
        modelId: cfg.model,
        detail: err.message,
      });
      return c.json({ error: 'generation failed', detail: err.message }, 502);
    }
  }

  // Render segments from the CLAIMS LIBRARY, not from model output. The model
  // chose ids; the text comes from the approved record. This is what makes the
  // "verbatim" rule structural rather than a request the model might ignore.
  const byId = new Map(claims.map((cl) => [cl.id, cl]));
  const segments = selected
    .map((claimId, i) => {
      const cl = byId.get(claimId);
      return {
        ordinal: i + 1,
        text: cl ? cl.claim_text : `[unresolved claim ${claimId}]`,
        claimId: cl ? claimId : null,
      };
    })
    .filter((s) => s.text.length > 0);

  await c.env.DB.prepare(`DELETE FROM artifact_segments WHERE artifact_id = ?`).bind(id).run();
  for (const s of segments) {
    await c.env.DB.prepare(
      `INSERT INTO artifact_segments (artifact_id, ordinal, text, claim_id) VALUES (?, ?, ?, ?)`,
    )
      .bind(id, s.ordinal, s.text, s.claimId)
      .run();
  }

  const lintResult = runLint(segments, claims);

  // Content-addressed snapshot in R2. The key IS the hash of the content, so
  // "show me exactly what was reviewed" is answerable forever.
  const snapshotBody = JSON.stringify({ artifactId: id, segments, lint: lintResult }, null, 2);
  const digest = await sha256Hex(snapshotBody);
  const snapshotKey = `artifacts/${id}/${digest}.json`;
  await c.env.SNAPSHOTS.put(snapshotKey, snapshotBody, {
    httpMetadata: { contentType: 'application/json' },
  });

  await c.env.DB.prepare(
    `UPDATE artifacts SET state = ?, body = ?, lint_status = ?, prompt_version = ?,
            model_id = ?, snapshot_key = ?, updated_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(next, JSON.stringify(segments), lintResult.status, CURRENT_PROMPT, cfg.model, snapshotKey, id)
    .run();

  await appendAudit(c.env, {
    artifactId: id,
    eventType: 'generated',
    actor: 'system:generator',
    fromState: artifact.state,
    toState: next,
    promptVersion: CURRENT_PROMPT,
    modelId: cfg.model,
    temperature: String(cfg.temperature),
    request,
    response,
    snapshotKey,
    detail: `lint=${lintResult.status}; ${lintResult.findings.length} finding(s)`,
  });

  return c.json({ id, state: next, segments, lint: lintResult, snapshotKey });
});

/** generated -> in_review. Requires lint pass AND full provenance. */
app.post('/api/artifacts/:id/submit', async (c) => {
  const id = c.req.param('id');
  const artifact = await c.env.DB.prepare(`SELECT * FROM artifacts WHERE id = ?`)
    .bind(id)
    .first<any>();
  if (!artifact) return c.json({ error: 'not found' }, 404);

  const { segments, claims } = await loadForLint(c.env, artifact);
  const lintResult = runLint(segments, claims);
  const allLinked = segments.length > 0 && segments.every((s) => s.claimId !== null);

  let next: ArtifactState;
  try {
    next = transition(artifact.state as ArtifactState, 'submit_for_review', {
      actor: actorOf(c),
      lintStatus: lintResult.status,
      allSegmentsLinked: allLinked,
    });
  } catch (e) {
    return transitionError(c, e, { lint: lintResult });
  }

  await setState(c.env, id, next);
  await appendAudit(c.env, {
    artifactId: id,
    eventType: 'submitted_for_review',
    actor: actorOf(c) ?? 'system:submitter',
    fromState: artifact.state,
    toState: next,
    detail: `lint=${lintResult.status}`,
  });
  return c.json({ id, state: next, lint: lintResult });
});

/** in_review -> approved | rejected. HUMAN ONLY. */
for (const [route, event] of [
  ['approve', 'approve'],
  ['reject', 'reject'],
] as const) {
  app.post(`/api/artifacts/:id/${route}`, async (c) => {
    const id = c.req.param('id');
    const artifact = await c.env.DB.prepare(`SELECT * FROM artifacts WHERE id = ?`)
      .bind(id)
      .first<any>();
    if (!artifact) return c.json({ error: 'not found' }, 404);

    const actor = actorOf(c);
    let next: ArtifactState;
    try {
      next = transition(artifact.state as ArtifactState, event, { actor });
    } catch (e) {
      return transitionError(c, e);
    }

    let note = '';
    try {
      note = ((await c.req.json<{ note?: string }>())?.note ?? '').toString();
    } catch {
      /* body optional */
    }

    await setState(c.env, id, next);
    await appendAudit(c.env, {
      artifactId: id,
      eventType: event === 'approve' ? 'approved' : 'rejected',
      actor: actor!,
      fromState: artifact.state,
      toState: next,
      snapshotKey: artifact.snapshot_key,
      detail: note,
    });
    return c.json({ id, state: next });
  });
}

/** approved -> published. HUMAN ONLY, and only from `approved`. */
app.post('/api/artifacts/:id/publish', async (c) => {
  const id = c.req.param('id');
  const artifact = await c.env.DB.prepare(`SELECT * FROM artifacts WHERE id = ?`)
    .bind(id)
    .first<any>();
  if (!artifact) return c.json({ error: 'not found' }, 404);

  const actor = actorOf(c);
  let next: ArtifactState;
  try {
    next = transition(artifact.state as ArtifactState, 'publish', { actor });
  } catch (e) {
    return transitionError(c, e);
  }

  await setState(c.env, id, next);
  await appendAudit(c.env, {
    artifactId: id,
    eventType: 'published',
    actor: actor!,
    fromState: artifact.state,
    toState: next,
    snapshotKey: artifact.snapshot_key,
    // In a real deployment this is where the asset is pushed into the DAM and
    // the review workflow is started, using the artifact's own snapshot as the
    // payload. The system of record stays authoritative on approval state.
    detail: 'ready for downstream distribution',
  });
  return c.json({ id, state: next });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

app.get('/api/artifacts/:id/audit/verify', async (c) => {
  const id = c.req.param('id');
  // The hash chain is GLOBAL and append-only: every event links to the previous
  // event in the whole log, not the previous event for this artifact. That is
  // the stronger property (deleting an artifact's entire history is detectable
  // too), but it means verification MUST run over the full log. Verifying only
  // one artifact's slice reports a false break at its first entry, because that
  // entry's prev_hash legitimately points at another artifact's event.
  const { results } = await c.env.DB.prepare(
    `SELECT seq, artifact_id, event_type, actor, at, from_state, to_state,
            prompt_version, model_id, temperature, request_json, response_json,
            detail, snapshot_key, prev_hash, entry_hash
       FROM audit_events ORDER BY seq`,
  ).all<any>();

  const rows = results.map((r) => ({
    seq: r.seq,
    artifactId: r.artifact_id,
    eventType: r.event_type,
    actor: r.actor,
    at: r.at,
    fromState: r.from_state,
    toState: r.to_state,
    promptVersion: r.prompt_version,
    modelId: r.model_id,
    temperature: r.temperature,
    request: r.request_json ? JSON.parse(r.request_json) : null,
    response: r.response_json ? JSON.parse(r.response_json) : null,
    detail: r.detail,
    snapshotKey: r.snapshot_key,
    prevHash: r.prev_hash,
    entryHash: r.entry_hash,
  }));

  const verification = await verifyChain(rows as any);
  return c.json({
    // Whole-log integrity, plus how much of it belongs to this artifact.
    entries: rows.length,
    artifactEntries: rows.filter((r) => r.artifactId === id).length,
    scope: 'global append-only log',
    verification,
  });
});

app.get('/api/snapshots/*', async (c) => {
  const key = c.req.path.replace('/api/snapshots/', '');
  const obj = await c.env.SNAPSHOTS.get(key);
  if (!obj) return c.json({ error: 'snapshot not found' }, 404);
  return new Response(obj.body, { headers: { 'content-type': 'application/json' } });
});

// SPA fallback for everything that is not /api.
app.all('*', async (c) => c.env.ASSETS.fetch(c.req.raw));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function transitionError(c: any, e: unknown, extra: Record<string, unknown> = {}) {
  if (e instanceof TransitionError) {
    return c.json({ error: e.message, from: e.from, event: e.event, ...extra }, 409);
  }
  throw e;
}

async function setState(env: Env, id: string, state: ArtifactState) {
  await env.DB.prepare(`UPDATE artifacts SET state = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(state, id)
    .run();
}

async function loadForLint(env: Env, artifact: any) {
  const { results: segRows } = await env.DB.prepare(
    `SELECT ordinal, text, claim_id FROM artifact_segments WHERE artifact_id = ? ORDER BY ordinal`,
  )
    .bind(artifact.id)
    .all<any>();
  const { results: claims } = await env.DB.prepare(
    `SELECT id, claim_text, claim_type FROM claims
      WHERE product = ? AND audience = ? AND status = 'approved'`,
  )
    .bind(artifact.product, artifact.audience)
    .all<any>();
  const segments: Segment[] = segRows.map((r) => ({
    ordinal: r.ordinal,
    text: r.text,
    claimId: r.claim_id ?? null,
  }));
  return { segments, claims };
}

function runLint(segments: Segment[], claims: Array<{ id: string; claim_text: string; claim_type: string }>) {
  return lint({
    segments,
    allowedClaimIds: claims.map((c) => c.id),
    requiredSafetyClaimIds: claims.filter((c) => c.claim_type === 'safety').map((c) => c.id),
    claimTextById: Object.fromEntries(claims.map((c) => [c.id, c.claim_text])),
  });
}

/** Deterministic offline selection: safety claims first, then the rest. */
function deterministicFallback(claims: Array<{ id: string; claim_type: string }>): string[] {
  const safety = claims.filter((c) => c.claim_type === 'safety').map((c) => c.id);
  const rest = claims.filter((c) => c.claim_type !== 'safety').map((c) => c.id);
  return [...rest.slice(0, 1), ...safety, ...rest.slice(1)];
}

async function appendAudit(env: Env, input: AuditInput) {
  const prev = await env.DB.prepare(
    `SELECT entry_hash FROM audit_events ORDER BY seq DESC LIMIT 1`,
  ).first<{ entry_hash: string }>();
  const prevHash = prev?.entry_hash ?? null;
  const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const entryHash = await hashEntry(input, at, prevHash);

  await env.DB.prepare(
    `INSERT INTO audit_events
       (artifact_id, event_type, actor, at, from_state, to_state, prompt_version,
        model_id, temperature, request_json, response_json, detail, snapshot_key,
        prev_hash, entry_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      input.artifactId,
      input.eventType,
      input.actor,
      at,
      input.fromState ?? null,
      input.toState ?? null,
      input.promptVersion ?? null,
      input.modelId ?? null,
      input.temperature ?? null,
      input.request ? JSON.stringify(input.request) : null,
      input.response ? JSON.stringify(input.response) : null,
      input.detail ?? null,
      input.snapshotKey ?? null,
      prevHash,
      entryHash,
    )
    .run();
}

export default app;
