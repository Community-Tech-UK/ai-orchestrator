import { Injectable, InjectionToken, inject } from '@angular/core';
import type {
  TerminalLifecycleEvent,
  TerminalSession,
  TerminalSessionId,
  TerminalSpawnOptions,
} from '../../../../shared/types/terminal.types';

const TERMINAL_STUB_SESSION_ID = '__terminal_stub__';
const NOT_IMPLEMENTED = 'TerminalSession is not yet implemented (Wave 4b).';

export const TERMINAL_SESSION = new InjectionToken<TerminalSession>('TERMINAL_SESSION', {
  providedIn: 'root',
  factory: () => inject(TerminalSessionStub),
});

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

  subscribe(listener: (event: TerminalLifecycleEvent) => void): () => void {
    let active = true;

    queueMicrotask(() => {
      if (!active) return;
      listener({
        kind: 'error',
        sessionId: TERMINAL_STUB_SESSION_ID,
        message: 'Terminal drawer is not yet implemented (Wave 4b).',
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
