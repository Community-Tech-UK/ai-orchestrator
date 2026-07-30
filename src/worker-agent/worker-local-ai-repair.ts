import {
  execFile as execFileCallback,
  spawn as spawnProcess,
} from 'node:child_process';
import path from 'node:path';

const REPAIR_COMMAND_TIMEOUT_MS = 30_000;
const DETACHED_LAUNCH_TIMEOUT_MS = 5_000;

export type SupportedLocalAiPlatform = 'darwin' | 'win32' | 'linux';
export type ExecFilePort = (executable: string, args: readonly string[]) => Promise<void>;
export type LaunchDetachedPort = (executable: string, args: readonly string[]) => Promise<void>;

export interface RepairCommand {
  executable: string;
  args: readonly string[];
  allowProcessNotFound?: boolean;
  detached?: boolean;
}

export function resolveOllamaRestart(input: {
  platform: SupportedLocalAiPlatform;
  pathExists: (candidate: string) => boolean;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}): RepairCommand[] | null {
  if (input.platform === 'darwin') {
    const app = [
      '/Applications/Ollama.app',
      path.join(input.homeDir, 'Applications', 'Ollama.app'),
    ].find(input.pathExists);
    return app
      ? [
          {
            executable: '/usr/bin/osascript',
            args: ['-e', 'tell application "Ollama" to quit'],
          },
          { executable: '/usr/bin/open', args: ['-a', 'Ollama'] },
        ]
      : null;
  }

  if (input.platform === 'win32') {
    const candidates = [
      input.env['LOCALAPPDATA']
        ? path.win32.join(input.env['LOCALAPPDATA'], 'Programs', 'Ollama', 'ollama app.exe')
        : null,
      input.env['ProgramFiles']
        ? path.win32.join(input.env['ProgramFiles'], 'Ollama', 'ollama app.exe')
        : null,
      input.env['ProgramFiles(x86)']
        ? path.win32.join(input.env['ProgramFiles(x86)'], 'Ollama', 'ollama app.exe')
        : null,
    ].filter((candidate): candidate is string => candidate !== null);
    const executable = candidates.find(input.pathExists);
    return executable
      ? [
          {
            executable: 'C:\\Windows\\System32\\taskkill.exe',
            args: ['/F', '/IM', 'ollama app.exe'],
            allowProcessNotFound: true,
          },
          { executable, args: [], detached: true },
        ]
      : null;
  }

  const systemctl = ['/usr/bin/systemctl', '/bin/systemctl'].find(input.pathExists);
  const ollama = ['/usr/local/bin/ollama', '/usr/bin/ollama', '/snap/bin/ollama']
    .find(input.pathExists);
  return systemctl && ollama
    ? [{ executable: systemctl, args: ['--user', 'restart', 'ollama.service'] }]
    : null;
}

export function executeFile(executable: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFileCallback(executable, [...args], {
      windowsHide: true,
      timeout: REPAIR_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }, (error) => error ? reject(error) : resolve());
  });
}

export function launchDetached(executable: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawnProcess(executable, [...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    const timeoutId = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Detached repair launch timed out'));
    }, DETACHED_LAUNCH_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
    child.once('spawn', () => {
      clearTimeout(timeoutId);
      child.unref();
      resolve();
    });
  });
}

export function isProcessNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 128 || code === '128';
}
