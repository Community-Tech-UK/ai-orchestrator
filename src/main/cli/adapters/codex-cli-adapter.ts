/**
 * Codex CLI Adapter - Spawns and manages OpenAI Codex CLI processes
 * https://github.com/openai/codex
 *
 * Dual-mode operation:
 *   1. **App-server mode** (preferred): persistent JSON-RPC server via
 *      `codex app-server` with real-time streaming, native threads, and
 *      optional broker for multi-instance process sharing.
 *   2. **Exec mode** (fallback): `codex exec` / `codex exec resume` for
 *      older Codex CLI versions that lack app-server support.
 *
 * The adapter auto-detects which mode to use at spawn time.
 *
 */

import { CodexAppServerTurnAdapter } from './codex-app-server-turn-adapter';
import type { CodexCliConfig } from './codex-adapter-config';
import type {
  ContextUsage,
  InstanceStatus,
  OutputMessage,
} from '../../../shared/types/instance.types';
import { getModelCapabilitiesRegistry } from '../../providers/model-capabilities';
import { CODEX_TIMEOUTS } from '../../../shared/constants/limits';
import { CodexTimeoutError, type CodexExecPhase, type CodexTimeoutKind } from './codex/exec-timeout';

export { isCodexContextDiagnosticsEnabled } from './codex-app-server-adapter';
export type { CodexCliConfig } from './codex-adapter-config';

/**
 * Events emitted by CodexCliAdapter (for InstanceManager compatibility)
 */
export interface CodexCliAdapterEvents {
  'context': (usage: ContextUsage) => void;
  'error': (error: Error) => void;
  'exit': (code: number | null, signal: string | null) => void;
  'output': (message: OutputMessage) => void;
  'spawned': (pid: number) => void;
  'status': (status: InstanceStatus) => void;
}

export { CodexTimeoutError };
export type { CodexExecPhase, CodexTimeoutKind };

// ─── Adapter ────────────────────────────────────────────────────────────────

/**
 * Codex CLI Adapter - Implementation for OpenAI Codex CLI
 *
 * Supports dual-mode operation: app-server (persistent JSON-RPC) and
 * exec (spawn-per-message) with automatic detection and fallback.
 */
export class CodexCliAdapter extends CodexAppServerTurnAdapter {
  constructor(config: CodexCliConfig = {}) {
    super(config);
  }

  /**
   * Resolves the context-window size. Prefers the value reported by Codex via
   * `thread/tokenUsage/updated` (authoritative), then falls back to the
   * model-capabilities registry, and finally to `CONTEXT_WINDOWS.CODEX_DEFAULT`.
   */
  protected override resolveContextWindow(): number {
    if (this.codexReportedContextWindow > 0) {
      return this.codexReportedContextWindow;
    }
    const model = this.cliConfig.model ?? 'default';
    const caps = getModelCapabilitiesRegistry().getCapabilities('codex', model);
    return caps.contextWindow;
  }

  /**
   * Total per-attempt budget for a turn, measured from spawn. Every producer
   * of `CodexCliConfig.timeout` (cross-model review, loop iterations,
   * magic-prompt, compare, auto-title) intends a *total* deadline — not an
   * idle budget. `0`/negative/`NaN` are treated as unset.
   */
  protected override resolveDeadlineMs(): number {
    const configuredTimeout = this.cliConfig.timeout;
    if (typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout > 0) {
      return configuredTimeout;
    }
    return CODEX_TIMEOUTS.EXEC_TURN_MS;
  }

  /**
   * Idle (silence) budget for exec turns. Uses the built-in turn constant —
   * codex exec emits output only at item boundaries, so the configured total
   * timeout must NOT shrink this (a 120s review deadline used to kill codex
   * mid-reasoning at 120s of silence). It is only *capped* by the deadline:
   * a 30s deadline shouldn't wait 60s of silence to report.
   */
  protected override resolveTurnIdleTimeoutMs(): number {
    return Math.min(CODEX_TIMEOUTS.EXEC_TURN_MS, this.resolveDeadlineMs());
  }

  /** Short handshake budget before `turn/started`; long budget thereafter.
   * Item boundaries are not liveness boundaries because Codex may reason
   * silently for minutes before emitting its next notification. */
  protected override resolveNotificationIdleTimeoutMs(turnEstablished: boolean): number {
    const base = turnEstablished
      ? CODEX_TIMEOUTS.NOTIFICATION_IDLE_ACTIVE_MS
      : CODEX_TIMEOUTS.NOTIFICATION_IDLE_MS;
    return Math.min(base, this.resolveDeadlineMs());
  }
}
