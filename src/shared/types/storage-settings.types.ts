/** Storage controls are split out because AppSettings is at its LOC ceiling. */
export interface StorageSettings {
  /** Opt-in automatic removal of reconcile backups beyond the newest three. */
  codexBackupKeepThree: boolean;
}
