import type {
  AutomationDeliveryMode,
  AutomationTriggerSource,
} from '../../shared/types/automation.types';

export interface AutomationRunDecisionOptions {
  idempotencyKey?: string;
  triggerSource?: AutomationTriggerSource;
  deliveryMode?: AutomationDeliveryMode;
  /** Override max attempts for this run (default = 1, meaning no retries). */
  maxAttempts?: number;
  /** Current attempt number (default = 1). Used when reinserting a retry run. */
  attempt?: number;
  /**
   * A delivery-specific prompt already rendered at an authenticated ingress
   * boundary. It is persisted only in this run's snapshot; the operator's
   * reusable automation template remains unchanged.
   */
  promptOverride?: string;
}
