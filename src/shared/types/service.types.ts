export type ServiceState = 'running' | 'stopped' | 'not-installed' | 'unknown';

export interface ServiceStatus {
  state: ServiceState;
  pid?: number;
  uptimeSeconds?: number;
  version?: string;
  binaryPath?: string;
  configPath?: string;
  logPath?: string;
  startedAt?: number;
}
