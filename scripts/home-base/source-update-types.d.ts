export interface SourceUpdateConfig {
  version: 1;
  repositoryPath: string;
  remote: 'origin';
  branch: 'main';
  appPath: string;
  nodePath: string;
  driverPath: string;
  stateDirectory: string;
}
export interface SessionIdentity {
  instanceId: string;
  historyEntryId: string;
  providerSessionId?: string;
  workingDirectory: string;
  accountProfileId?: string;
}
export interface CommandResult { code: number; stdout: string; stderr: string }
export type Run = (file: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<CommandResult>;
export interface DriverRuntime {
  run: Run;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  alive: (pid: number) => boolean;
}
