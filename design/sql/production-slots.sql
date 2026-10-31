-- Minimal M0 proof table; the slot constraints move into migration 0004.
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  production_status TEXT NOT NULL CHECK (production_status IN (
    'awaiting_quote', 'awaiting_authorization', 'awaiting_artwork',
    'awaiting_materials', 'awaiting_preparation', 'ready', 'in_production',
    'quality_control', 'production_complete'
  )),
  production_slot INTEGER NULL CHECK (production_slot IN (1, 2)),
  CHECK ((production_status = 'in_production') = (production_slot IS NOT NULL))
);
CREATE UNIQUE INDEX one_job_per_slot ON orders (production_slot) WHERE production_slot IS NOT NULL;
