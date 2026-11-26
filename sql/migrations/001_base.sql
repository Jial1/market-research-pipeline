-- Initial public tables. Apply through the explicit migration command.

CREATE TABLE IF NOT EXISTS trading_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,                          -- Date of report
  symbol VARCHAR(10) NOT NULL,                 -- Stock ticker
  entry_price FLOAT NOT NULL,                  -- Predicted entry level
  trade_direction VARCHAR(10) NOT NULL DEFAULT 'long'
    CHECK (trade_direction IN ('long', 'short')),
  entry_prediction VARCHAR(100),               -- Entry type (breakout/pullback/etc)
  target_price FLOAT,                          -- Profit target
  stop_loss FLOAT,                             -- Risk/stop loss level
  ai_confidence FLOAT,                         -- 0-1 confidence score
  risk_reward FLOAT,                           -- Reward/risk ratio at recommendation time
  setup_score INTEGER,                         -- 0-100 deterministic/AI setup quality score
  setup_quality VARCHAR(5),                    -- A/B/C/D grade derived from setup_score
  structure TEXT,                              -- Structure assessment shown in executable card
  momentum TEXT,                               -- Momentum assessment shown in executable card
  liquidity TEXT,                              -- Liquidity/stop zone assessment
  catalyst TEXT,                               -- Concrete catalyst note
  reason TEXT,                                 -- Short setup thesis
  risk TEXT,                                   -- Short risk/invalidation explanation
  market_regime VARCHAR(50),                   -- risk_on/risk_off/etc
  catalyst_type VARCHAR(50),                   -- earnings/macro/sector/etc
  report_text TEXT,                            -- Full AI-generated report
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS option_chain_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(10) NOT NULL,
  option_symbol VARCHAR(32),
  snapshot_date DATE NOT NULL,
  expiration DATE NOT NULL,
  strike FLOAT NOT NULL,
  option_type VARCHAR(10) NOT NULL CHECK (option_type IN ('call', 'put')),
  bid FLOAT,
  ask FLOAT,
  last FLOAT,
  mid FLOAT,
  volume INTEGER,
  open_interest INTEGER,
  implied_volatility FLOAT,
  delta FLOAT,
  gamma FLOAT,
  theta FLOAT,
  vega FLOAT,
  days_to_expiration INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS option_supplements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_report_id UUID REFERENCES trading_reports(id) ON DELETE CASCADE,
  symbol VARCHAR(10) NOT NULL,
  linked_stock_direction VARCHAR(10),
  option_type VARCHAR(10),
  strategy VARCHAR(30) NOT NULL,
  expiration DATE,
  days_to_expiration INTEGER,
  strike FLOAT,
  moneyness VARCHAR(20),
  bid FLOAT,
  ask FLOAT,
  last FLOAT,
  mid FLOAT,
  premium_cost FLOAT,
  expiration_breakeven FLOAT,
  distance_to_breakeven_pct FLOAT,
  bid_ask_spread_pct FLOAT,
  volume INTEGER,
  open_interest INTEGER,
  implied_volatility FLOAT,
  delta FLOAT,
  gamma FLOAT,
  theta FLOAT,
  vega FLOAT,
  scenario_return_1d_underlying_1pct FLOAT,
  scenario_return_3d_underlying_2pct FLOAT,
  scenario_return_at_stock_target_5d FLOAT,
  scenario_return_at_stock_stop_3d FLOAT,
  theta_cost_1d_pct_of_premium FLOAT,
  target_reward_to_stop_loss_ratio FLOAT,
  liquidity_score INTEGER,
  pricing_score INTEGER,
  scenario_score INTEGER,
  option_score INTEGER,
  is_option_too_expensive BOOLEAN,
  expensive_reason TEXT,
  review_label VARCHAR(20),
  skip_reason TEXT,
  option_reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_option_chain_snapshot_unique ON option_chain_snapshots(symbol,snapshot_date,expiration,strike,option_type);

