import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

export interface ScriptStep {
  trigger: string;
  response?: string;
  exitCode?: number;
  delayMs?: number;
}

export interface MockChildProcess extends EventEmitter {
  pid: number;
  kill: ChildProcess['kill'];
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
}

export class MockCliHarness {
  private steps: ScriptStep[] = [];
  private proc: MockChildProcess | null = null;
  private stdinBuffer = '';

  script(steps: ScriptStep[]): this {
    this.steps = [...steps];
    return this;
  }

  createProcess(pid = 9999): MockChildProcess {
    const proc = new EventEmitter() as MockChildProcess;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();
    proc.killed = false;
    proc.pid = pid;
    proc.kill = ((signal?: string | number) => {
      if (!proc.killed) {
        proc.killed = true;
        this.emitLifecycle(
          proc,
          signal === 'SIGKILL' ? 137 : 0,
          typeof signal === 'string' ? signal : null,
        );
      }
      return true;
    }) as ChildProcess['kill'];

    const remainingSteps = [...this.steps];
    proc.stdin.on('data', (chunk: Buffer) => {
      this.stdinBuffer += chunk.toString();
      const step = remainingSteps[0];
      if (!step) return;
      if (!this.stdinBuffer.includes(step.trigger)) return;

      remainingSteps.shift();
      this.stdinBuffer = '';
      const fire = () => {
        if (step.exitCode !== undefined) {
          this.emitLifecycle(proc, step.exitCode);
          return;
        }
        if (step.response) {
          proc.stdout.write(step.response);
        }
      };

      if ((step.delayMs ?? 0) > 0) {
        setTimeout(fire, step.delayMs);
      } else {
        setImmediate(fire);
      }
    });

    this.proc = proc;
    return proc;
  }

  emitStdout(line: string): void {
    if (!this.proc) throw new Error('createProcess() must be called first');
    this.proc.stdout.write(line);
  }

  crash(code = 1): void {
    if (!this.proc) throw new Error('createProcess() must be called first');
    this.emitLifecycle(this.proc, code);
  }

  exit(): void {
    if (!this.proc) throw new Error('createProcess() must be called first');
    this.emitLifecycle(this.proc, 0);
  }

  private emitLifecycle(
    proc: MockChildProcess,
    code: number | null,
    signal: string | null = null,
  ): void {
    setImmediate(() => {
      proc.emit('exit', code, signal);
      proc.emit('close', code, signal);
    });
  }
}
