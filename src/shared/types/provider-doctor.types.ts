/**
 * Provider Doctor taxonomy types — error classification and structured repair actions.
 *
 * These types are populated by ProviderDoctor on the main process and flow through
 * DoctorService → ProviderDiagnosisSnapshot → IPC response and the redacted
 * operator-artifact bundle (provider-diagnoses.json).
 *
 * RepairAction.command is a PREVIEW shell string that is NEVER auto-executed.
 * It exists solely so operators and the Doctor UI can display/copy the fix.
 */

/**
 * Typed taxonomy for probe failures.  One value per distinct root cause so the
 * renderer (and future automation) can branch on kind without string-matching
 * free-text messages.
 */
export type ProviderProbeErrorKind =
  | 'cli_not_found'
  | 'cli_shadow_install'
  | 'cli_version_mismatch'
  | 'auth_missing'
  | 'auth_expired'
  | 'endpoint_unreachable'
  | 'unknown';

/**
 * Redacted bundle of recent runtime log lines collected from failed probes.
 * Secret patterns (API keys, tokens, passwords) are scrubbed before storage.
 * Useful for attaching to doctor diagnoses without leaking credentials.
 */
export interface RuntimeLogBundle {
  /**
   * Sanitized log lines from failed probes (probe name prefix + message).
   * At most 50 lines; each line is at most 512 characters.
   */
  entries: string[];
  /** Number of secret-pattern substitutions made across all entries. */
  redactedCount: number;
}

/**
 * A structured, human-readable repair action derived from a failed probe.
 * command is a PREVIEW shell template — it contains no secrets and is
 * never executed automatically.
 */
export interface RepairAction {
  /** Maps the action back to the error kind that triggered it. */
  kind: ProviderProbeErrorKind;
  /**
   * A safe shell string the operator or user can copy and run manually.
   * Must not contain secrets, tokens, or user-specific paths.
   */
  command: string;
  /** One-sentence explanation of what the command does. */
  description: string;
  /** How urgently the operator should act. */
  severity: 'info' | 'warning' | 'critical';
}
