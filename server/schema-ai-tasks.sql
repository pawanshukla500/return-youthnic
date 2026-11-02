-- Operator task center (Milestone 3: AI claim replies and task management).
--
-- Tasks are the human side of the worker loop: missing evidence, pending
-- approvals, claim rejections, tracking failures, expired panel sessions,
-- required operator actions, and overdue claim work. The worker creates them
-- (agent-authenticated, scoped to the agent's accounts); Supervisors and
-- Admins resolve them. Every task carries its source claim, an action history,
-- and a resolution note. Nothing here is ever deleted: resolving flips the
-- status, and the history stays for audit.
--
-- Additive and idempotent (IF NOT EXISTS / ON CONFLICT-free CREATE).

CREATE TABLE IF NOT EXISTS operator_tasks (
  id SERIAL PRIMARY KEY,
  claim_id INTEGER NOT NULL DEFAULT 0,
  marketplace_id INTEGER NOT NULL DEFAULT 0,
  marketplace TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'operator_action',
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  owner TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'worker',
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT operator_tasks_kind_check CHECK (kind IN ('missing_evidence', 'pending_approval', 'claim_rejection', 'tracking_failure', 'expired_session', 'operator_action', 'overdue_work')),
  CONSTRAINT operator_tasks_status_check CHECK (status IN ('open', 'resolved')),
  CONSTRAINT operator_tasks_source_check CHECK (source IN ('worker', 'operator'))
);

CREATE INDEX IF NOT EXISTS operator_tasks_status_idx
  ON operator_tasks (status);

CREATE INDEX IF NOT EXISTS operator_tasks_claim_idx
  ON operator_tasks (claim_id);

CREATE INDEX IF NOT EXISTS operator_tasks_marketplace_idx
  ON operator_tasks (marketplace_id);

CREATE INDEX IF NOT EXISTS operator_tasks_created_idx
  ON operator_tasks (created_at);
