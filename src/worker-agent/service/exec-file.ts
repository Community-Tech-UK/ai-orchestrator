import { execFile } from 'node:child_process';

export class ExecFileError extends Error {
  override name = 'ExecFileError';
  constructor(
    public readonly file: string,
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly signal: NodeJS.Signals | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`${file} exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`);
  }
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecFileOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

export function execFileCapture(
  file: string,
  args: string[],
  opts: ExecFileOptions = {},
): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const stdoutStr = typeof stdout === 'string' ? stdout : (stdout as Buffer).toString('utf8');
        const stderrStr = typeof stderr === 'string' ? stderr : (stderr as Buffer).toString('utf8');
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number }).code;
          reject(
            new ExecFileError(
              file,
              args,
              typeof code === 'number' ? code : null,
              (err as NodeJS.ErrnoException & { signal?: NodeJS.Signals }).signal ?? null,
              stdoutStr,
              stderrStr,
            ),
          );
          return;
        }
        resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode: 0 });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}
