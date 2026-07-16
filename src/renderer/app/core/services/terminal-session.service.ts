import { Injectable, InjectionToken, inject } from '@angular/core';
import type {
  TerminalLifecycleEvent,
  TerminalSession,
  TerminalSessionId,
  TerminalSpawnOptions,
} from '../../../../shared/types/terminal.types';
import { ElectronIpcService } from './ipc/electron-ipc.service';

const TERMINAL_STUB_SESSION_ID = '__terminal_stub__';
const NOT_IMPLEMENTED = 'TerminalSession is not yet implemented (Wave 4b).';

/**
 * TERMINAL_SESSION resolves to the real {@link RemoteTerminalSessionService}
 * when the Electron preload bridge is present, and falls back to
 * {@link TerminalSessionStub} in browser/test contexts so DI never explodes.
 */
export const TERMINAL_SESSION = new InjectionToken<TerminalSession>('TERMINAL_SESSION', {
  providedIn: 'root',
  factory: () => {
    const api = inject(ElectronIpcService).getApi();
    return api && typeof api.terminalSpawn === 'function'
      ? inject(RemoteTerminalSessionService)
      : inject(TerminalSessionStub);
  },
});

interface TerminalOutputPayload {
  sessionId: string;
  data: string;
}
interface TerminalExitPayload {
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
}
interface TerminalSpawnedPayload {
  sessionId: string;
  pid: number;
  nodeId: string;
}

/**
 * Real terminal session — proxies to the main process over IPC, which in turn
 * drives the worker node's PTY (Piece C). REMOTE only: a `nodeId` is required;
 * spawning without one is a clear, actionable error rather than a silent local
 * fallback (local terminals would need node-pty in the Electron main process).
 */
@Injectable({ providedIn: 'root' })
export class RemoteTerminalSessionService implements TerminalSession {
  private readonly ipc = inject(ElectronIpcService);

  async spawn(opts: TerminalSpawnOptions): Promise<{ sessionId: TerminalSessionId; pid: number }> {
    if (!opts.nodeId) {
      throw new Error(
        'Select a worker node to open a remote terminal — local terminals are not supported yet.',
      );
    }
    const res = await this.requireApi().terminalSpawn({
      nodeId: opts.nodeId,
      cwd: opts.cwd,
      shell: opts.shell,
      env: opts.env,
      cols: opts.cols,
      rows: opts.rows,
    });
    if (!res?.success) {
      throw new Error(res?.error?.message ?? 'Failed to spawn terminal');
    }
    return res.data as { sessionId: TerminalSessionId; pid: number };
  }

  async write(sessionId: TerminalSessionId, data: string): Promise<void> {
    const res = await this.requireApi().terminalWrite(sessionId, data);
    if (!res?.success) throw new Error(res?.error?.message ?? 'Failed to write to terminal');
  }

  async resize(sessionId: TerminalSessionId, cols: number, rows: number): Promise<void> {
    const res = await this.requireApi().terminalResize(sessionId, cols, rows);
    if (!res?.success) throw new Error(res?.error?.message ?? 'Failed to resize terminal');
  }

  async kill(sessionId: TerminalSessionId, signal?: NodeJS.Signals): Promise<void> {
    const res = await this.requireApi().terminalKill(sessionId, signal);
    if (!res?.success) throw new Error(res?.error?.message ?? 'Failed to kill terminal');
  }

  async getBufferedOutput(sessionId: TerminalSessionId): Promise<string | null> {
    const res = await this.requireApi().terminalGetBuffer(sessionId);
    if (!res?.success) return null;
    return (res.data as { output: string | null } | undefined)?.output ?? null;
  }

  subscribe(listener: (event: TerminalLifecycleEvent) => void): () => void {
    const api = this.ipc.getApi();
    if (!api) return () => undefined;
    const offs = [
      api.onTerminalSpawned((payload: unknown) => {
        const e = payload as TerminalSpawnedPayload;
        listener({ kind: 'spawned', sessionId: e.sessionId, pid: e.pid });
      }),
      api.onTerminalOutput((payload: unknown) => {
        const e = payload as TerminalOutputPayload;
        listener({ kind: 'data', sessionId: e.sessionId, data: e.data });
      }),
      api.onTerminalExit((payload: unknown) => {
        const e = payload as TerminalExitPayload;
        listener({ kind: 'exited', sessionId: e.sessionId, code: e.exitCode, signal: e.signal });
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  private requireApi() {
    const api = this.ipc.getApi();
    if (!api) throw new Error('Terminal is unavailable: the Electron bridge is not present.');
    return api;
  }
}

@Injectable({ providedIn: 'root' })
export class TerminalSessionStub implements TerminalSession {
  spawn(opts: TerminalSpawnOptions): Promise<{ sessionId: TerminalSessionId; pid: number }> {
    void opts;
    return this.fail('spawn');
  }

  write(sessionId: TerminalSessionId, data: string): Promise<void> {
    void sessionId;
    void data;
    return this.fail('write');
  }

  resize(sessionId: TerminalSessionId, cols: number, rows: number): Promise<void> {
    void sessionId;
    void cols;
    void rows;
    return this.fail('resize');
  }

  kill(sessionId: TerminalSessionId, signal?: NodeJS.Signals): Promise<void> {
    void sessionId;
    void signal;
    return this.fail('kill');
  }

  getBufferedOutput(sessionId: TerminalSessionId): Promise<string | null> {
    void sessionId;
    return Promise.resolve(null);
  }

  subscribe(listener: (event: TerminalLifecycleEvent) => void): () => void {
    let active = true;

    queueMicrotask(() => {
      if (!active) return;
      listener({
        kind: 'error',
        sessionId: TERMINAL_STUB_SESSION_ID,
        message: 'Terminal drawer is not available in this context.',
      });
    });

    return () => {
      active = false;
    };
  }

  private fail<T>(action: string): Promise<T> {
    return Promise.reject(new Error(`${action}: ${NOT_IMPLEMENTED}`));
  }
}
