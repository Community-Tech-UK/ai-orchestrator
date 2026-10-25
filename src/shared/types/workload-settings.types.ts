export type WorkloadLevel = 1 | 2 | 3 | 4 | 5;

export interface WorkloadSettings {
  /** Affects new unattended work only; Balanced preserves each engine's settings. */
  workloadLevel: WorkloadLevel;
}
