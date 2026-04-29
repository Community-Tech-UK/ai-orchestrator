export type TerminalSessionId = string;

export interface TerminalSpawnOptions {
  cwd: string;
  shell?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export type TerminalLifecycleEvent =
  | { kind: 'spawned'; sessionId: TerminalSessionId; pid: number }
  | { kind: 'data'; sessionId: TerminalSessionId; data: string }
  | { kind: 'exited'; sessionId: TerminalSessionId; code: number | null; signal: string | null }
  | { kind: 'error'; sessionId: TerminalSessionId; message: string };

export interface TerminalSession {
  spawn(opts: TerminalSpawnOptions): Promise<{ sessionId: TerminalSessionId; pid: number }>;
  write(sessionId: TerminalSessionId, data: string): Promise<void>;
  resize(sessionId: TerminalSessionId, cols: number, rows: number): Promise<void>;
  kill(sessionId: TerminalSessionId, signal?: NodeJS.Signals): Promise<void>;
  subscribe(listener: (event: TerminalLifecycleEvent) => void): () => void;
}
