-- Snapshot fallback store.
--
-- Snapshots are content-addressed artifact bodies: the key IS the SHA-256 of
-- the content, so "show me exactly what the reviewer approved" stays answerable.
-- R2 is the right home for them (cheap, no egress fees, unbounded). This table
-- exists so the system still works on an account where R2 has not been enabled,
-- because a missing object store should not disable the audit trail.
--
-- The Worker prefers R2 whenever the binding is present and falls back to here.
CREATE TABLE IF NOT EXISTS snapshots (
  key        TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
