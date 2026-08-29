-- mlr-guard schema (Cloudflare D1 / SQLite)
--
-- Design rule: the LLM is never the authority on what is true or approved.
-- The claims library is. Generated text is only ever an ARRANGEMENT of
-- claims that a human already approved, and the arrangement itself is
-- approved by a human before it can be published.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- REFERENCES: the substantiating source documents.
-- An "anchor" is the specific locator inside the reference (page/section/table)
-- that supports the claim, which is what a reviewer actually needs to check.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reference_docs (
  id            TEXT PRIMARY KEY,
  citation      TEXT NOT NULL,
  anchor        TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- CLAIMS: pre-approved statements. A claim is usable only while status='approved'.
-- Every claim MUST link to a reference (enforced by NOT NULL + FK).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claims (
  id            TEXT PRIMARY KEY,
  product       TEXT NOT NULL,
  audience      TEXT NOT NULL CHECK (audience IN ('hcp','patient')),
  claim_text    TEXT NOT NULL,
  reference_id  TEXT NOT NULL REFERENCES reference_docs(id),
  status        TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','retired')),
  -- 'safety' claims are the required risk/ISI blocks; 'comparative' claims are
  -- the ones that most often get an asset rejected, so they are typed.
  claim_type    TEXT NOT NULL DEFAULT 'efficacy'
                CHECK (claim_type IN ('efficacy','safety','indication','comparative')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claims_lookup ON claims(product, audience, status);

-- ---------------------------------------------------------------------------
-- PROMPT VERSIONS: prompts are versioned records, not strings in the codebase.
-- An artifact points at the exact prompt version that produced it, forever.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prompt_versions (
  id            TEXT PRIMARY KEY,          -- e.g. assemble@3
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  body          TEXT NOT NULL,
  body_sha256   TEXT NOT NULL,             -- detects silent edits
  frozen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  notes         TEXT,
  UNIQUE (name, version)
);

-- ---------------------------------------------------------------------------
-- ARTIFACTS: one piece of promotional content moving through review.
-- state is the ONLY thing that gates publication, and it is advanced solely
-- by the transition function in src/domain/state.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifacts (
  id             TEXT PRIMARY KEY,
  product        TEXT NOT NULL,
  audience       TEXT NOT NULL CHECK (audience IN ('hcp','patient')),
  channel        TEXT NOT NULL,
  brief          TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'draft'
                 CHECK (state IN ('draft','generated','in_review','approved','published','rejected')),
  body           TEXT,                     -- assembled copy (JSON array of segments)
  lint_status    TEXT,                     -- 'pass' | 'fail'
  prompt_version TEXT REFERENCES prompt_versions(id),
  model_id       TEXT,                     -- pinned, e.g. gpt-4o-mini-2024-07-18
  snapshot_key   TEXT,                     -- R2 object key (content-addressed)
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- SEGMENT LINKS: the provenance join. One row per generated sentence.
-- If a sentence has no row here, it is unlinked, and unlinked text cannot pass
-- the linter. This table is what makes the output reviewable at all.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifact_segments (
  artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  text          TEXT NOT NULL,
  claim_id      TEXT REFERENCES claims(id),   -- NULL = unlinked = blocks approval
  PRIMARY KEY (artifact_id, ordinal)
);

-- ---------------------------------------------------------------------------
-- AUDIT EVENTS: append-only, hash-chained.
-- prev_hash/entry_hash make a silent edit or deletion detectable, which is the
-- difference between a log and an audit trail. There is no UPDATE or DELETE
-- path to this table anywhere in the codebase.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id    TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  actor          TEXT NOT NULL,             -- authenticated identity, never 'system' for approvals
  at             TEXT NOT NULL DEFAULT (datetime('now')),
  from_state     TEXT,
  to_state       TEXT,
  -- The full generation record. For a regulated, NON-DETERMINISTIC system the
  -- final value is not enough: you need the inputs, the model identity and the
  -- human decision to be able to reconstruct why the output is what it is.
  prompt_version TEXT,
  model_id       TEXT,
  temperature    TEXT,
  request_json   TEXT,
  response_json  TEXT,
  detail         TEXT,
  snapshot_key   TEXT,
  prev_hash      TEXT,
  entry_hash     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_artifact ON audit_events(artifact_id, seq);
