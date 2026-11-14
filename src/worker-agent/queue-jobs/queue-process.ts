import { spawn } from 'node:child_process';

export interface ProcessResult {
  /** Null when the program was stopped (time limit) or could not start. */
  code: number | null;
  timedOut: boolean;
  /** The end of what the program printed, with anything secret-looking blanked. */
  tail: string;
}

/** Runs a program with a time limit. Injectable so specs never start a real `npm`. */
export type QueueProcessRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<ProcessResult>;

const TAIL_CHARS = 4000;

/** Blank values that look like credentials before output is logged or sent anywhere. */
export function redactTail(text: string): string {
  return text
    .replace(/((?:token|password|passwd|secret|api[_-]?key|_auth(?:token)?)\s*[=:]\s*)\S+/gi, '$1[hidden]')
    .replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, '$1[hidden]');
}

/**
 * Starts `command` without a shell, except for `npm` on Windows (a `.cmd` file needs one; the arguments here are
 * fixed words and checked script names). Stops the whole process tree at the time limit.
 */
export const runProcess: QueueProcessRunner = (command, args, { cwd, timeoutMs }) => new Promise<ProcessResult>(resolve => {
  const windows = process.platform === 'win32';
  const useShell = windows && command === 'npm';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
  let tail = '';
  let timedOut = false;
  let done = false;
  const finish = (code: number | null): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve({ code, timedOut, tail: redactTail(tail).slice(-TAIL_CHARS) });
  };
  const child = spawn(useShell ? 'npm.cmd' : command, [...args], {
    cwd, env, shell: useShell, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer): void => { tail = (tail + chunk.toString('utf8')).slice(-TAIL_CHARS * 2); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
  }, timeoutMs);
  child.on('error', error => { tail += `\n${error.message}`; finish(null); });
  child.on('close', code => finish(code));
});

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}
