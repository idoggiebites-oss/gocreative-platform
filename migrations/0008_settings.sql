-- Business-wide switches read at request time. A row with key 'maintenance' makes every write answer 503 (worker/index.ts), which is how scripts/backup.ts gets a consistent snapshot.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
