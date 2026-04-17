export type ServiceState = 'running' | 'stopped' | 'not-installed' | 'unknown';

export interface ServiceStatus {
  state: ServiceState;
  pid?: number;
  uptimeSeconds?: number;
  version?: string;
  binaryPath?: string;
  configPath?: string;
  logPath?: string;
  startedAt?: number; // epoch ms
}

export interface ServiceInstallOptions {
  binaryPath: string;        // Absolute path to worker SEA binary
  configPath: string;        // Absolute path to worker-node.json
  coordinatorUrl: string;    // ws://host:port
  enrollmentToken: string;   // Already resolved from token-resolver
  serviceAccount?: string;   // Defaults per platform
  serviceName?: string;      // Defaults to 'ai-orchestrator-worker'
  logDir?: string;           // Defaults per platform
  version?: string;          // Semver; drop into <binDir>/versions/<version>/
}

export interface ServiceManager {
  install(opts: ServiceInstallOptions): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
  isInstalled(): Promise<boolean>;
}
