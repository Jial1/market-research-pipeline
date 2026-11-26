const { assertSchemaVersion } = require("./schemaVersion");
const { summarizeEvaluation } = require("./evaluationMetrics");
const { feedback_issuance_days } = require("../config/evaluation-contract.json");
const { Client } = require('pg');

class DatabaseClient {
  constructor(connectionString) {
    if (!connectionString) {
      throw new Error('DATABASE_URL is required');
    }
    this.connectionString = connectionString;
    this.client = null;
  }

  async connect() {
    this.client = new Client({ 
      connectionString: this.connectionString,
      connectionTimeoutMillis: 10000,
      statement_timeout: 30000,
      ssl: new URL(this.connectionString).searchParams.get("sslmode") === "disable" ? false : undefined
    });
    
    try {
      await this.client.connect();
      console.log('✓ Connected to database');
    } catch (error) {
      console.error('Failed to connect to database:', error.message);
      throw error;
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.end();
      console.log('✓ Disconnected from database');
    }
  }

  async storePlan(plan) {
    if (!plan.run_id || !plan.issued_at || !plan.eligible_session || !plan.order_type || !plan.evaluation_policy) {
      throw new Error("Tracked plans require run, issuance and evaluation metadata");
    }
    await this.client.query(`INSERT INTO trading_reports (
      date,symbol,entry_price,trade_direction,entry_prediction,target_price,stop_loss,ai_confidence,
      risk_reward,setup_score,setup_quality,structure,momentum,liquidity,catalyst,reason,risk,
      market_regime,catalyst_type,run_id,issued_at,eligible_session,order_type,evaluation_policy
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
    ON CONFLICT (run_id,symbol) DO NOTHING`, [
      plan.date,plan.symbol,plan.entry_price,plan.trade_direction,plan.entry_prediction,
      plan.target_price,plan.stop_loss,plan.ai_confidence,plan.risk_reward,plan.setup_score,
      plan.setup_quality,plan.structure,plan.momentum,plan.liquidity,plan.catalyst,plan.reason,plan.risk,
      plan.market_regime,plan.catalyst_type,plan.run_id,plan.issued_at,plan.eligible_session,
      plan.order_type,JSON.stringify(plan.evaluation_policy)
    ]);
  }

  async validateSchema() {
    try { await assertSchemaVersion(this.client); return true; }
    catch { console.error("Portfolio schema is not current; run npm run db:migrate"); return false; }
  }

  async getCorrectEvaluationContext(version, days = feedback_issuance_days, namespace = "", cutoff = null) {
    const result = await this.client.query(`SELECT e.evaluation_version,e.state,e.was_entry_hit,e.net_return_pct,e.gross_return_pct,e.ambiguous
      FROM recommendation_evaluations e JOIN trading_reports r ON r.id=e.report_id
      JOIN report_runs runs ON runs.id=r.run_id
      WHERE e.evaluation_version=$1 AND r.issued_at >= COALESCE($4::timestamptz,now())-($2::int * INTERVAL '24 hours')
        AND r.issued_at <= COALESCE($4::timestamptz,now()) AND e.cutoff <= COALESCE($4::timestamptz,now())
        AND COALESCE(runs.settings->>'runNamespace','')=$3`, [version, days, namespace, cutoff]);
    return { evaluation_version: version, days, ...summarizeEvaluation(result.rows, version) };
  }

}
module.exports = { DatabaseClient };
