ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS operational_summaries JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS email_started_at TIMESTAMPTZ;
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS email_reconciliation JSONB;
