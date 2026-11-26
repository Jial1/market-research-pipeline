-- Preserve historical text missing from the saved output without changing replay artifacts.
-- Old per-stock text and options tables remain archives pending a separately reviewed cleanup.
ALTER TABLE report_runs ADD COLUMN legacy_report_texts JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(legacy_report_texts) = 'array');

UPDATE report_runs runs SET legacy_report_texts = (
  SELECT jsonb_agg(text ORDER BY text COLLATE "C") FROM (
    SELECT DISTINCT reports.report_text COLLATE "C" AS text
    FROM trading_reports reports
    WHERE reports.run_id = runs.id AND reports.report_text IS NOT NULL
      AND reports.report_text IS DISTINCT FROM runs.output->>'report'
  ) texts
)
WHERE EXISTS (
  SELECT 1 FROM trading_reports reports
  WHERE reports.run_id = runs.id AND reports.report_text IS NOT NULL
    AND reports.report_text IS DISTINCT FROM runs.output->>'report'
);
