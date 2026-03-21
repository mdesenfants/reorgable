CREATE TABLE IF NOT EXISTS brief_engagement (
  id TEXT PRIMARY KEY,
  report_run_id TEXT NOT NULL,
  remarkable_doc_id TEXT,
  remarkable_doc_name TEXT,
  uploaded_at TEXT NOT NULL,
  last_seen_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY(report_run_id) REFERENCES report_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_brief_engagement_report_run ON brief_engagement(report_run_id);
CREATE INDEX IF NOT EXISTS idx_brief_engagement_uploaded ON brief_engagement(uploaded_at);

-- Add remarkable_doc_id column to report_runs so we can track the uploaded doc
ALTER TABLE report_runs ADD COLUMN remarkable_doc_id TEXT;
