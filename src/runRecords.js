class RunRecords {
  constructor(database) { this.database = database; this.client = database.client; this.key = null; }
  async claim(key, date, settings, model) {
    const lock = await this.client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired", [key]);
    if (!lock.rows[0].acquired) return null;
    this.key = key;
    await this.client.query(`INSERT INTO report_runs(run_key,report_date,settings,model)
      VALUES($1,$2,$3,$4) ON CONFLICT(run_key) DO NOTHING`, [key, date, JSON.stringify(settings), model]);
    return (await this.client.query("SELECT * FROM report_runs WHERE run_key=$1", [key])).rows[0];
  }
  async saveSnapshot(id, snapshot) {
    await this.client.query("UPDATE report_runs SET snapshot=$2,status='running',error_category=NULL,updated_at=now() WHERE id=$1", [id, JSON.stringify(snapshot)]);
  }
  async saveOutput(id, output) {
    await this.client.query("UPDATE report_runs SET output=$2,updated_at=now() WHERE id=$1", [id, JSON.stringify(output)]);
  }
  async storePlans(run, output) {
    const plans = output.recommendations;
    if (new Set(plans.map(plan => String(plan.symbol).trim().toUpperCase())).size !== plans.length) {
      throw new Error("Duplicate recommendation symbols cannot be stored");
    }
    if (plans.some(plan => !["long", "short"].includes(plan.trade_direction)
      || ![plan.entry_price, plan.target_price, plan.stop_loss].every(value => Number.isFinite(value) && value > 0))) {
      throw new Error("Invalid recommendation prices or direction cannot be stored");
    }
    await this.client.query("BEGIN");
    try {
      const current = (await this.client.query("SELECT recommendations_stored FROM report_runs WHERE id=$1 FOR UPDATE", [run.id])).rows[0];
      if (!current.recommendations_stored) {
        for (const plan of output.recommendations) {
          await this.database.storePlan({ ...plan, date: run.report_date,
            run_id: run.id, issued_at: output.issued_at, eligible_session: output.eligible_session });
        }
        await this.client.query("UPDATE report_runs SET recommendations_stored=TRUE,updated_at=now() WHERE id=$1", [run.id]);
      }
      await this.client.query("COMMIT");
    } catch (error) { await this.client.query("ROLLBACK"); throw error; }
  }
  async beginEmail(id) {
    // Persist uncertainty BEFORE the network call. A crash must not cause resend.
    return (await this.client.query(`UPDATE report_runs SET email_status='unknown',email_started_at=now(),updated_at=now()
      WHERE id=$1 AND email_status='not_sent' RETURNING id`, [id])).rows.length === 1;
  }
  async complete(id, messageId) {
    await this.client.query(`UPDATE report_runs SET status='completed',email_status='sent',provider_message_id=$2,
      error_category=NULL,updated_at=now() WHERE id=$1`, [id, messageId || null]);
  }
  async completeWithoutEmail(id) {
    await this.client.query(`UPDATE report_runs SET status='completed',email_status='disabled',
      error_category=NULL,updated_at=now() WHERE id=$1 AND email_status='not_sent'`, [id]);
  }
  async fail(id, category) {
    await this.client.query("UPDATE report_runs SET status='failed',error_category=$2,updated_at=now() WHERE id=$1 AND status<>'completed'", [id, category]);
  }
  async release() {
    if (this.key) {
      await this.client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [this.key]);
      this.key = null;
    }
  }
}

module.exports = { RunRecords };
