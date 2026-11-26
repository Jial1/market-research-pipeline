CREATE TABLE IF NOT EXISTS report_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key TEXT NOT NULL UNIQUE,
  report_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','failed','completed')),
  snapshot JSONB,
  output JSONB,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  commit_sha TEXT,
  model TEXT,
  policy_version TEXT NOT NULL DEFAULT 'report-runs-v1',
  recommendations_stored BOOLEAN NOT NULL DEFAULT FALSE,
  email_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (email_status IN ('not_sent','unknown','sent','disabled')),
  provider_message_id TEXT,
  error_category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE trading_reports ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES report_runs(id);
ALTER TABLE trading_reports ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ;
ALTER TABLE trading_reports ADD COLUMN IF NOT EXISTS eligible_session DATE;
CREATE UNIQUE INDEX IF NOT EXISTS trading_reports_run_symbol ON trading_reports(run_id, symbol);
