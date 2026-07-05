/**
 * Ask Council Page — E4 Multi-Provider Compare UI (backlog #11).
 *
 * Sends the same prompt to multiple AI providers in parallel and displays
 * a side-by-side card per provider showing its answer, model, duration, or
 * an error when the provider is unavailable / returns a bad response.
 *
 * IPC used:
 *   compareListProviders  →  which providers are installed right now
 *   compareRun            →  fan-out and collect all answers
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CompareIpcService } from '../../core/services/ipc/compare-ipc.service';

// ─── domain types (mirrored from main-process service) ──────────────────────

export interface CompareCell {
  provider: string;
  ok: boolean;
  model?: string;
  answer?: string;
  error?: string;
  durationMs: number;
}

export interface CompareResult {
  prompt: string;
  results: CompareCell[];
}

// ─── component ───────────────────────────────────────────────────────────────

@Component({
  selector: 'app-ask-council-page',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <!-- Header -->
      <div class="page-header">
        <div class="header-title">
          <span class="title">Ask Council</span>
          <span class="subtitle">Send the same prompt to multiple AI providers and compare their answers side-by-side</span>
        </div>
      </div>

      <!-- Banners -->
      @if (errorMessage()) {
        <div class="banner banner-error" role="alert">{{ errorMessage() }}</div>
      }

      <!-- Prompt input area -->
      <div class="input-section">
        <textarea
          class="prompt-input"
          [value]="prompt()"
          placeholder="Enter your prompt here — all selected providers will receive exactly this text..."
          rows="4"
          (input)="onPromptInput($event)"
        ></textarea>

        <!-- Provider selector -->
        <div class="providers-row">
          <span class="providers-label">Providers</span>

          @if (loadingProviders()) {
            <span class="providers-loading">Detecting installed providers…</span>
          } @else if (availableProviders().length === 0) {
            <span class="providers-empty">No providers detected. Install Claude, Gemini, Copilot, or Codex CLI.</span>
          } @else {
            <div class="providers-list">
              @for (p of availableProviders(); track p) {
                <label class="provider-checkbox" [class.checked]="isSelected(p)">
                  <input
                    type="checkbox"
                    [checked]="isSelected(p)"
                    (change)="toggleProvider(p)"
                  />
                  <span class="provider-name">{{ p }}</span>
                </label>
              }
            </div>
          }

          <button
            class="btn btn-select-all"
            type="button"
            [disabled]="availableProviders().length === 0"
            (click)="selectAll()"
          >
            All
          </button>
          <button
            class="btn btn-clear"
            type="button"
            [disabled]="selectedProviders().length === 0"
            (click)="clearSelection()"
          >
            None
          </button>
        </div>

        <div class="actions-row">
          <button
            class="btn btn-primary"
            type="button"
            [disabled]="!canRun()"
            (click)="run()"
          >
            @if (running()) {
              Running…
            } @else {
              Ask Council
            }
          </button>

          @if (results()) {
            <button class="btn" type="button" (click)="clearResults()">Clear</button>
          }

          <span class="run-hint">{{ runHint() }}</span>
        </div>
      </div>

      <!-- Results -->
      @if (results(); as res) {
        <div class="results-section">
          <div class="results-header">
            <span class="results-count">
              {{ successCount() }} of {{ res.results.length }} provider{{ res.results.length !== 1 ? 's' : '' }} answered
            </span>
            @if (totalDurationMs()) {
              <span class="results-duration">slowest: {{ formatMs(maxDurationMs()) }}</span>
            }
          </div>

          <div class="cards-grid">
            @for (cell of res.results; track cell.provider) {
              <div class="card" [class.card-ok]="cell.ok" [class.card-error]="!cell.ok">
                <div class="card-header">
                  <span class="card-provider">{{ cell.provider }}</span>
                  @if (cell.model) {
                    <span class="card-model">{{ cell.model }}</span>
                  }
                  <span class="card-duration">{{ formatMs(cell.durationMs) }}</span>
                  <span class="card-status" [class.status-ok]="cell.ok" [class.status-error]="!cell.ok">
                    {{ cell.ok ? 'OK' : 'Error' }}
                  </span>
                </div>

                @if (cell.ok && cell.answer) {
                  <div class="card-body card-answer">{{ cell.answer }}</div>
                } @else if (!cell.ok && cell.error) {
                  <div class="card-body card-error-msg">{{ cell.error }}</div>
                }
              </div>
            }
          </div>
        </div>
      } @else if (!running() && !results()) {
        <div class="empty-state">
          Select providers above, enter a prompt, then click <strong>Ask Council</strong>.
        </div>
      }

      @if (running()) {
        <div class="running-indicator">
          <span class="spinner" aria-label="Running"></span>
          Waiting for {{ runningCount() }} provider{{ runningCount() !== 1 ? 's' : '' }}…
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      width: 100%;
      height: 100%;
    }

    .page {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md, 12px);
      padding: var(--spacing-lg, 20px);
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow: hidden;
    }

    /* Header */
    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md, 12px);
      flex-shrink: 0;
    }

    .header-title {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
    }

    .title {
      font-size: 18px;
      font-weight: 700;
    }

    .subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }

    /* Banners */
    .banner {
      padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
      border-radius: var(--radius-sm, 4px);
      font-size: 12px;
      flex-shrink: 0;
    }

    .banner-error {
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
    }

    /* Input section */
    .input-section {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm, 8px);
      flex-shrink: 0;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md, 6px);
      padding: var(--spacing-md, 12px);
    }

    .prompt-input {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
      border-radius: var(--radius-sm, 4px);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
      font-size: 13px;
      font-family: inherit;
    }

    .prompt-input::placeholder {
      color: var(--text-muted);
    }

    /* Providers row */
    .providers-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      flex-wrap: wrap;
    }

    .providers-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }

    .providers-loading,
    .providers-empty {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
    }

    .providers-list {
      display: flex;
      gap: var(--spacing-xs, 4px);
      flex-wrap: wrap;
      flex: 1;
    }

    .provider-checkbox {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm, 4px);
      background: var(--bg-tertiary);
      cursor: pointer;
      font-size: 12px;
      user-select: none;
      transition: border-color 0.1s, background 0.1s;
    }

    .provider-checkbox:hover {
      border-color: var(--primary-color);
    }

    .provider-checkbox.checked {
      border-color: var(--primary-color);
      background: color-mix(in srgb, var(--primary-color) 15%, var(--bg-tertiary));
    }

    .provider-checkbox input[type="checkbox"] {
      margin: 0;
      cursor: pointer;
    }

    .provider-name {
      color: var(--text-primary);
      font-weight: 500;
    }

    /* Actions row */
    .actions-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
    }

    .run-hint {
      font-size: 11px;
      color: var(--text-muted);
    }

    /* Buttons */
    .btn {
      border-radius: var(--radius-sm, 4px);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: 4px 12px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-primary {
      background: var(--primary-color, #4a90e2);
      border-color: var(--primary-color, #4a90e2);
      color: #fff;
      font-weight: 600;
      padding: 6px 16px;
    }

    .btn-primary:disabled {
      opacity: 0.5;
    }

    /* Results */
    .results-section {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm, 8px);
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }

    .results-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md, 12px);
      flex-shrink: 0;
    }

    .results-count {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .results-duration {
      font-size: 11px;
      color: var(--text-muted);
    }

    /* Cards grid */
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: var(--spacing-md, 12px);
      align-items: start;
    }

    .card {
      display: flex;
      flex-direction: column;
      border-radius: var(--radius-md, 6px);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      overflow: hidden;
      min-height: 80px;
    }

    .card-ok {
      border-color: color-mix(in srgb, var(--success-color, #4caf50) 50%, var(--border-color));
    }

    .card-error {
      border-color: color-mix(in srgb, var(--error-color, #f44336) 50%, var(--border-color));
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      padding: 6px 12px;
      background: var(--bg-tertiary);
      border-bottom: 1px solid var(--border-color);
      flex-wrap: wrap;
    }

    .card-provider {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-primary);
      text-transform: capitalize;
    }

    .card-model {
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--font-family-mono, monospace);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .card-duration {
      font-size: 10px;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .card-status {
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 999px;
      white-space: nowrap;
    }

    .status-ok {
      background: color-mix(in srgb, var(--success-color, #4caf50) 20%, transparent);
      color: var(--success-color, #4caf50);
    }

    .status-error {
      background: color-mix(in srgb, var(--error-color, #f44336) 20%, transparent);
      color: var(--error-color, #f44336);
    }

    .card-body {
      padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
      font-size: 12px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }

    .card-answer {
      color: var(--text-primary);
      white-space: pre-wrap;
    }

    .card-error-msg {
      color: var(--error-color, #f44336);
      font-style: italic;
    }

    /* Empty / running states */
    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      min-height: 100px;
      border: 1px dashed var(--border-color);
      border-radius: var(--radius-md, 6px);
      color: var(--text-muted);
      font-size: 13px;
      text-align: center;
      padding: var(--spacing-lg, 20px);
    }

    .running-indicator {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
      color: var(--text-secondary);
      font-size: 12px;
      flex-shrink: 0;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid var(--border-color);
      border-top-color: var(--primary-color, #4a90e2);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
  `],
})
export class AskCouncilPageComponent implements OnInit {
  private readonly compareIpc = inject(CompareIpcService);

  // ── prompt / provider state ────────────────────────────────────────────────
  readonly prompt = signal('');
  readonly availableProviders = signal<string[]>([]);
  readonly selectedProviders = signal<string[]>([]);

  // ── UI / async state ───────────────────────────────────────────────────────
  readonly loadingProviders = signal(false);
  readonly running = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly results = signal<CompareResult | null>(null);

  // ── derived ────────────────────────────────────────────────────────────────
  readonly canRun = computed(
    () =>
      !this.running() &&
      this.prompt().trim().length > 0 &&
      this.selectedProviders().length > 0,
  );

  readonly runHint = computed(() => {
    if (this.running()) return '';
    if (this.prompt().trim().length === 0) return 'Enter a prompt first.';
    if (this.selectedProviders().length === 0) return 'Select at least one provider.';
    return `Will ask ${this.selectedProviders().length} provider${this.selectedProviders().length !== 1 ? 's' : ''}.`;
  });

  readonly successCount = computed(() => {
    const res = this.results();
    if (!res) return 0;
    return res.results.filter((c) => c.ok).length;
  });

  readonly maxDurationMs = computed(() => {
    const res = this.results();
    if (!res || res.results.length === 0) return 0;
    return Math.max(...res.results.map((c) => c.durationMs));
  });

  readonly totalDurationMs = computed(() => this.maxDurationMs() > 0);

  readonly runningCount = computed(() => this.selectedProviders().length);

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    await this.loadProviders();
  }

  // ── actions ────────────────────────────────────────────────────────────────

  onPromptInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.prompt.set(target.value);
  }

  isSelected(provider: string): boolean {
    return this.selectedProviders().includes(provider);
  }

  toggleProvider(provider: string): void {
    const current = this.selectedProviders();
    if (current.includes(provider)) {
      this.selectedProviders.set(current.filter((p) => p !== provider));
    } else {
      this.selectedProviders.set([...current, provider]);
    }
  }

  selectAll(): void {
    this.selectedProviders.set([...this.availableProviders()]);
  }

  clearSelection(): void {
    this.selectedProviders.set([]);
  }

  clearResults(): void {
    this.results.set(null);
    this.errorMessage.set(null);
  }

  async run(): Promise<void> {
    if (!this.canRun()) return;

    this.errorMessage.set(null);
    this.results.set(null);
    this.running.set(true);

    try {
      const response = await this.compareIpc.compareRun({
        prompt: this.prompt().trim(),
        providers: this.selectedProviders(),
      });

      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Compare run failed.');
        return;
      }

      const raw = response.data as CompareResult | undefined;
      if (!raw || !Array.isArray(raw.results)) {
        this.errorMessage.set('Unexpected response format from compare run.');
        return;
      }

      this.results.set(raw);
    } finally {
      this.running.set(false);
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  private async loadProviders(): Promise<void> {
    this.loadingProviders.set(true);
    try {
      const response = await this.compareIpc.compareListProviders();
      if (response.success && Array.isArray(response.data)) {
        const providers = response.data as string[];
        this.availableProviders.set(providers);
        // Pre-select all available providers by default
        this.selectedProviders.set([...providers]);
      }
    } finally {
      this.loadingProviders.set(false);
    }
  }
}
