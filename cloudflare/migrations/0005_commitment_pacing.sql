-- D1 Migration 0005: Commitment Pacing tables
-- Decision staging gates (Explore → Soft Commit → Hard Commit → Locked)
-- See SOLUTION_commitment_pacing.md for design rationale.

CREATE TABLE IF NOT EXISTS commitment_stages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  commitment_type TEXT NOT NULL CHECK (commitment_type IN ('contract','expense','investment','project','hire','subscription')),
  current_stage TEXT NOT NULL DEFAULT 'explore' CHECK (current_stage IN ('explore','soft_commit','hard_commit','locked','abandoned')),
  amount REAL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  monthly_impact REAL,
  counterparty TEXT,
  related_contract_id TEXT REFERENCES contracts(id) ON DELETE SET NULL,
  related_invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  related_scenario_id TEXT REFERENCES scenarios(id) ON DELETE SET NULL,
  gate_rules_json TEXT,
  stage_history_json TEXT,
  risk_score REAL DEFAULT 0,
  reversibility_score REAL DEFAULT 1.0,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_commitment_stages_user_id ON commitment_stages(user_id);
CREATE INDEX IF NOT EXISTS idx_commitment_stages_current_stage ON commitment_stages(current_stage);
CREATE INDEX IF NOT EXISTS idx_commitment_stages_type ON commitment_stages(commitment_type);
CREATE INDEX IF NOT EXISTS idx_commitment_stages_updated_at ON commitment_stages(updated_at);

CREATE TABLE IF NOT EXISTS commitment_transitions (
  id TEXT PRIMARY KEY,
  commitment_id TEXT NOT NULL REFERENCES commitment_stages(id) ON DELETE CASCADE,
  from_stage TEXT NOT NULL,
  to_stage TEXT NOT NULL,
  gate_result_json TEXT,
  decision_notes TEXT,
  decided_by TEXT,
  financial_snapshot_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_commitment_transitions_commitment_id ON commitment_transitions(commitment_id);
CREATE INDEX IF NOT EXISTS idx_commitment_transitions_created_at ON commitment_transitions(created_at);
