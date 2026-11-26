ALTER TABLE trading_reports ADD COLUMN IF NOT EXISTS order_type TEXT;
ALTER TABLE trading_reports ADD COLUMN IF NOT EXISTS evaluation_policy JSONB;
CREATE TABLE IF NOT EXISTS recommendation_evaluations (
  report_id UUID NOT NULL REFERENCES trading_reports(id) ON DELETE CASCADE,
  evaluation_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','unavailable','won','lost','time_exit','expired','invalidated','research_only')),
  cutoff TIMESTAMPTZ NOT NULL,
  terminal BOOLEAN NOT NULL,
  was_entry_hit BOOLEAN NOT NULL DEFAULT FALSE,
  gross_return_pct DOUBLE PRECISION,
  net_return_pct DOUBLE PRECISION,
  ambiguous BOOLEAN NOT NULL DEFAULT FALSE,
  details JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(report_id, evaluation_version)
);
CREATE TABLE IF NOT EXISTS evaluation_metrics (
  date DATE NOT NULL,
  evaluation_version TEXT NOT NULL,
  summary JSONB NOT NULL,
  PRIMARY KEY(date, evaluation_version)
);
