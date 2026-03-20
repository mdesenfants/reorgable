CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK(source_type IN ('task', 'document', 'email')),
  title TEXT NOT NULL,
  summary_input TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at);
CREATE INDEX IF NOT EXISTS idx_items_source_type ON items(source_type);

CREATE TABLE IF NOT EXISTS report_runs (
  id TEXT PRIMARY KEY,
  run_at TEXT NOT NULL,
  source_count INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  upload_status TEXT NOT NULL,
  upload_message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_runs_run_at ON report_runs(run_at);
