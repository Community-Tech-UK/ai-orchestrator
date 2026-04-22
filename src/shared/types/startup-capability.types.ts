export type StartupCapabilityCheckStatus =
  | 'ready'
  | 'degraded'
  | 'unavailable'
  | 'disabled';

export type StartupCapabilityCategory =
  | 'native'
  | 'provider'
  | 'subsystem';

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
