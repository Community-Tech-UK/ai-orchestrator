/**
 * LSP post-edit feedback loop (backlog #13).
 *
 * Subscribes to the internal file-edit bus and, after an agent finishes editing,
 * fetches LSP diagnostics for the touched files and injects any ERRORS back to
 * the agent as a follow-up note so it can self-correct — the opencode "edit →
 * diagnostics → feed back" trick.
 *
 * Design choices for safety (this auto-sends messages to a running agent):
 *   - DISABLED by default; the host enables it explicitly.
 *   - Only ERROR-severity diagnostics are surfaced (warnings/hints are noise).
 *   - Per-instance debounce coalesces a burst of edits into one check.
 *   - Only injects when the instance is idle (between turns), never mid-turn.
 *   - Loop guard: identical error sets are not re-injected, so an unfixable
 *     error can't ping-pong forever.
 *
 * All collaborators are injected, so the logic is unit-testable without an LSP,
 * an instance manager, or the real bus.
 */

import { getLogger } from '../logging/logger';
import { getFileEditBus, type FileEditedEvent } from '../instance/file-edit-bus';

const logger = getLogger('LspFeedback');

export type LspSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface LspDiagnostic {
  severity: LspSeverity;
  message: string;
  line?: number;
}

export interface LspFeedbackDeps {
  /** Master switch. Default-off; injected by the host. */
  isEnabled(): boolean;
  /** Only inject between turns. */
  isInstanceIdle(instanceId: string): boolean;
  /** Returns diagnostics for a file, or null when the LSP is unavailable. */
  getDiagnostics(filePath: string): Promise<LspDiagnostic[] | null>;
  /** Inject the formatted feedback note to the agent (e.g. a follow-up input). */
  injectFeedback(instanceId: string, note: string): Promise<void> | void;
  /** Subscribe to edits. Defaults to the internal file-edit bus. */
  subscribe?: (listener: (event: FileEditedEvent) => void) => () => void;
  /** Debounce window for coalescing an edit burst. Default 1200ms. */
  debounceMs?: number;
  /** Max files to report on. Default 20. */
  maxFiles?: number;
  /** Max error lines in the note. Default 25. */
  maxErrors?: number;
}

interface InstanceState {
  files: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  lastKey: string | null;
}

export class LspFeedbackCoordinator {
  private readonly deps: Required<Pick<LspFeedbackDeps,
    'isEnabled' | 'isInstanceIdle' | 'getDiagnostics' | 'injectFeedback'>> &
    Pick<LspFeedbackDeps, 'subscribe'> & { debounceMs: number; maxFiles: number; maxErrors: number };
  private readonly states = new Map<string, InstanceState>();
  private unsubscribe: (() => void) | null = null;

  constructor(deps: LspFeedbackDeps) {
    this.deps = {
      isEnabled: deps.isEnabled,
      isInstanceIdle: deps.isInstanceIdle,
      getDiagnostics: deps.getDiagnostics,
      injectFeedback: deps.injectFeedback,
      subscribe: deps.subscribe,
      debounceMs: deps.debounceMs ?? 1200,
      maxFiles: deps.maxFiles ?? 20,
      maxErrors: deps.maxErrors ?? 25,
    };
  }

  /** Begin listening for file edits. */
  attach(): void {
    if (this.unsubscribe) return;
    const subscribe = this.deps.subscribe ?? ((cb) => getFileEditBus().onEdited(cb));
    this.unsubscribe = subscribe((event) => this.onEdited(event));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const s of this.states.values()) {
      if (s.timer) clearTimeout(s.timer);
    }
    this.states.clear();
  }

  /** Drop accumulated state for a terminated instance (prevents a slow leak). */
  forgetInstance(instanceId: string): void {
    const s = this.states.get(instanceId);
    if (s?.timer) clearTimeout(s.timer);
    this.states.delete(instanceId);
  }

  private stateFor(instanceId: string): InstanceState {
    let s = this.states.get(instanceId);
    if (!s) {
      s = { files: new Set<string>(), timer: null, lastKey: null };
      this.states.set(instanceId, s);
    }
    return s;
  }

  private onEdited(event: FileEditedEvent): void {
    if (!this.deps.isEnabled()) return;
    const s = this.stateFor(event.instanceId);
    if (s.files.size < this.deps.maxFiles) s.files.add(event.filePath);
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      void this.flush(event.instanceId);
    }, this.deps.debounceMs);
  }

  private async flush(instanceId: string): Promise<void> {
    const s = this.states.get(instanceId);
    if (!s) return;
    s.timer = null;
    const files = [...s.files];
    s.files.clear();

    if (!this.deps.isEnabled() || files.length === 0) return;
    if (!this.deps.isInstanceIdle(instanceId)) return; // never inject mid-turn

    const errorsByFile: Array<{ file: string; diags: LspDiagnostic[] }> = [];
    for (const file of files) {
      let diags: LspDiagnostic[] | null;
      try {
        diags = await this.deps.getDiagnostics(file);
      } catch (error) {
        logger.debug('getDiagnostics failed', { file, error: String(error) });
        continue;
      }
      if (!diags) continue; // LSP unavailable for this file
      const errors = diags.filter((d) => d.severity === 'error');
      if (errors.length > 0) errorsByFile.push({ file, diags: errors });
    }

    if (errorsByFile.length === 0) return;

    const key = this.signature(errorsByFile);
    if (key === s.lastKey) return; // identical errors already reported — no loop
    s.lastKey = key;

    const note = this.formatNote(errorsByFile);
    try {
      await this.deps.injectFeedback(instanceId, note);
    } catch (error) {
      logger.warn('injectFeedback failed', { instanceId, error: String(error) });
    }
  }

  private signature(byFile: Array<{ file: string; diags: LspDiagnostic[] }>): string {
    return byFile
      .map((e) => `${e.file}:${e.diags.map((d) => `${d.line ?? 0}:${d.message}`).sort().join('|')}`)
      .sort()
      .join('||');
  }

  private formatNote(byFile: Array<{ file: string; diags: LspDiagnostic[] }>): string {
    const lines: string[] = ['LSP reported errors after your edits — please fix them:'];
    let count = 0;
    for (const { file, diags } of byFile) {
      for (const d of diags) {
        if (count >= this.deps.maxErrors) break;
        lines.push(`- ${file}${d.line !== undefined ? `:${d.line}` : ''}: ${d.message}`);
        count++;
      }
      if (count >= this.deps.maxErrors) {
        lines.push('… (additional errors omitted)');
        break;
      }
    }
    return lines.join('\n');
  }
}
