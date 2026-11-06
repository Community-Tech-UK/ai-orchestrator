export type StartupCapabilityCheckStatus =
  | 'ready'
  | 'degraded'
  | 'unavailable'
  | 'disabled';

export type StartupCapabilityCategory =
  | 'native'
  | 'provider'
  | 'subsystem';

/**
 * Where "fix it" leads for a check that needs attention. The probe states it
 * in `details.fix` because only the probe knows why a check is not ready (a
 * missing tool and a signed-out tool need different fixes); the title bar and
 * banner only map it to a button. `details` is a free-form record on the wire,
 * so naming it there needs no schema change.
 */
export type StartupCheckFix = 'accounts' | 'remote-computers' | 'browser' | 'setup';

/**
 * Why a provider check is not ready, kept in `details.problem` so other
 * screens can tell "not installed" from "installed but unhealthy" without
 * parsing the sentence.
 */
export type StartupCheckProblem = 'not-installed' | 'not-signed-in' | 'needs-attention' | 'check-failed';

export interface StartupCapabilityCheck {
  id: string;
  label: string;
  category: StartupCapabilityCategory;
  status: StartupCapabilityCheckStatus;
  critical: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export type StartupCapabilityOverallStatus =
  | 'ready'
  | 'degraded'
  | 'failed';

export interface StartupCapabilityReport {
  status: StartupCapabilityOverallStatus;
  generatedAt: number;
  checks: StartupCapabilityCheck[];
}
