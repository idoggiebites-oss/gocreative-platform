-- E3: how many prices a public session has asked for, so the estimate route can't be walked for a whole price list. Additive: one counter, starting at zero.
ALTER TABLE inquiry_submissions ADD COLUMN estimate_calls INTEGER NOT NULL DEFAULT 0;
