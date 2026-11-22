import type { OutputMessage } from '../../../../shared/types/instance.types';
import { generateId } from '../../../../shared/utils/id-generator';
import type { AppServerNotification } from './app-server-types';
import type { CodexDiagnostic } from './exec-diagnostics';
import { claimCodexDiagnosticSlot, codexDiagnosticOutput } from './exec-log-presentation';

/**
 * `mcpServer/startupStatus/updated` params (Codex 0.171 `McpServerStatusUpdatedNotification`):
 * `{ threadId: string | null, name, environmentId, status: 'starting' | 'ready' | 'failed' | 'cancelled',
 *    error: string | null, failureReason: 'reauthenticationRequired' | null }`.
 */
const STARTUP_METHOD = 'mcpServer/startupStatus/updated';
/** The same closed character set `matchToolServerFailure` accepts for a server name. */
const SAFE_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@/-]{0,63}$/;
const MAX_ERROR_CHARS = 2000;
/** Failures held while the thread id is still unknown: a handful of servers, never an unbounded log. */
const MAX_HELD = 16;

/** The notice for a failed tool-server start of this session's thread; null for any other status or thread. */
export function classifyToolServerStartup(params: Record<string, unknown>, ownThreadId: string | null): CodexDiagnostic | null {
  if (params['status'] !== 'failed') return null;
  const threadId = params['threadId'];
  if (typeof threadId === 'string' && threadId !== ownThreadId) return null;
  const name = typeof params['name'] === 'string' ? params['name'] : '';
  const error = typeof params['error'] === 'string' ? params['error'].slice(0, MAX_ERROR_CHARS) : '';
  const reauthenticate = params['failureReason'] === 'reauthenticationRequired';
  return {
    category: 'tool-server',
    fatal: false,
    level: 'warning',
    line: `MCP server ${name.slice(0, 64) || 'unknown'} failed to start${reauthenticate ? ' (sign-in required)' : ''}${error ? `: ${error}` : ''}`,
    ...(SAFE_SERVER_NAME.test(name) ? { toolServer: name } : {}),
  };
}

export interface ToolServerStartupHost {
  /** This session's native thread, or null before one exists. */
  threadId(): string | null;
  /** The turn being captured, when there is one; its object is the once-per-turn key. */
  activeTurn(): object | null;
  emitOutput(output: OutputMessage): void;
}

/**
 * Shows an app-server session's failed tool-server start the way the `codex exec` path does: one plain message per
 * turn, the server's safe name where available, the provider's own text only under Details. The app-server reports
 * this as a notification rather than a log line, and usually before the first turn, so failures that arrive while the
 * thread is still being created are held until its id is known.
 */
export class CodexToolServerStartupNotice {
  private holding = false;
  private held: AppServerNotification[] = [];
  private idleKey: object = {};

  constructor(private readonly host: ToolServerStartupHost) {}

  /** A new connection starts its tool servers afresh: hold failures until the thread exists. */
  begin(): void {
    this.holding = true;
    this.held = [];
    this.idleKey = {};
  }

  observe(notification: AppServerNotification): void {
    if (notification.method !== STARTUP_METHOD || notification.params['status'] !== 'failed') return;
    if (!this.holding) { this.report(notification); return; }
    if (this.held.length < MAX_HELD) this.held.push(notification);
  }

  /** The thread id is known: show what arrived while it was being created. */
  release(): void {
    const held = this.held;
    this.holding = false;
    this.held = [];
    for (const notification of held) this.report(notification);
  }

  private report(notification: AppServerNotification): void {
    const diagnostic = classifyToolServerStartup(notification.params, this.host.threadId());
    if (!diagnostic) return;
    // Outside a turn, one key per connection: the same start-up failure is not repeated while the session is idle.
    if (!claimCodexDiagnosticSlot(this.host.activeTurn() ?? this.idleKey, diagnostic)) return;
    this.host.emitOutput({ id: generateId(), timestamp: Date.now(), ...codexDiagnosticOutput(diagnostic) });
  }
}
