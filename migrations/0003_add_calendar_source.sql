CREATE TABLE items_new (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK(source_type IN ('task', 'document', 'email', 'note', 'calendar')),
  title TEXT NOT NULL,
  summary_input TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

INSERT INTO items_new (id, source_type, title, summary_input, metadata_json, idempotency_key, created_at)
SELECT id, source_type, title, summary_input, metadata_json, idempotency_key, created_at
FROM items;

DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at);
CREATE INDEX IF NOT EXISTS idx_items_source_type ON items(source_type);