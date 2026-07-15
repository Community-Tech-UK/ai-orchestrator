import type {
  AutomationConcurrencyPolicy,
  AutomationDeliveryMode,
  AutomationMissedRunPolicy,
  AutomationRunStatus,
  AutomationTrigger,
  AutomationTriggerSource,
} from '../../shared/types/automation.types';

export interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  active: number;
  /** Normalized working-directory project key (migration 034). */
  workspace_id: string;
  schedule_type: 'cron' | 'oneTime';
  schedule_json: string;
  trigger_json: string;
  missed_run_policy: AutomationMissedRunPolicy;
  concurrency_policy: AutomationConcurrencyPolicy;
  action_json: string;
  next_fire_at: number | null;
  last_fired_at: number | null;
  last_run_id: string | null;
  created_at: number;
  updated_at: number;
  unread_run_count?: number;
  consecutive_failures?: number;
  last_failure_at?: number | null;
  last_failure_reason?: string | null;
}

export interface AutomationRunRow {
  id: string;
  automation_id: string;
  status: AutomationRunStatus;
  trigger: AutomationTrigger;
  scheduled_at: number;
  started_at: number | null;
  finished_at: number | null;
  instance_id: string | null;
  error: string | null;
  output_summary: string | null;
  output_full_ref: string | null;
  idempotency_key: string | null;
  trigger_source_json: string | null;
  delivery_mode: AutomationDeliveryMode;
  seen_at: number | null;
  config_snapshot_json: string | null;
  created_at: number;
  updated_at: number;
  /** 1-based attempt number; 1 = first try, 2 = first retry, etc. */
  attempt: number;
  /** Maximum number of attempts allowed (including the first try). */
  max_attempts: number;
  /**
   * Pending-retry durability fields (migration 033).
   * When a retry timer is armed, these are written so the scheduler can
   * re-arm the timer after a restart.  Cleared when the retry actually fires
   * or is cancelled.
   */
  next_retry_at: number | null;
  next_retry_attempt: number | null;
  next_retry_max_attempts: number | null;
}

export interface AutomationThreadDestinationRow {
  automation_id: string;
  instance_id: string;
  session_id: string | null;
  history_entry_id: string | null;
  revive_if_archived: number;
}

export interface RunInsertExtras {
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  idempotencyKey?: string;
  triggerSource?: AutomationTriggerSource;
  deliveryMode?: AutomationDeliveryMode;
  /** 1-based attempt number (default 1 = first try). */
  attempt?: number;
  /** Maximum attempts allowed for this run (default 1 = no retries). */
  maxAttempts?: number;
}
