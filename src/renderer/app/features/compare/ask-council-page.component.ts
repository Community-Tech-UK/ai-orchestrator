/**
 * Ask Council Page — E4 Multi-Provider Compare UI (backlog #11) + WS-B6
 * progressive Council run with synthesis.
 *
 * Sends the same prompt to multiple AI providers and shows a per-provider
 * card that updates live as each provider resolves independently (queued ->
 * running -> succeeded/failed/cancelled) instead of waiting for all of them.
 * Once at least 2 members have completed, the user can synthesize the
 * answers via AIO's consensus algorithm, a full debate-moderated synthesis,
 * or a single chosen provider.
 *
 * Run state (including completed cards and synthesis) lives in
 * `AskCouncilStore`, which is `providedIn: 'root'` — navigating away from and
 * back to this page preserves the run; only a full renderer reload re-fetches
 * it from the main process's durable store.
 */

import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { AskCouncilStore } from './ask-council.store';
import type { CouncilMember, CouncilSynthesisMethod } from '../../core/services/ipc/compare-ipc.service';

type SynthesisChoice = 'consensus' | 'debate' | 'provider';

@Component({
  selector: 'app-ask-council-page',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ask-council-page.component.html',
  styleUrl: './ask-council-page.component.scss',
})
export class AskCouncilPageComponent implements OnInit {
  private readonly store = inject(AskCouncilStore);

  // ── prompt / provider selection (page-local; the run itself lives in the store) ──
  readonly prompt = signal('');
  readonly selectedProviders = signal<string[]>([]);
  readonly synthesisChoice = signal<SynthesisChoice>('consensus');
  readonly synthesisProviderId = signal<string | null>(null);

  // ── store passthroughs ─────────────────────────────────────────────────────
  readonly availableProviders = this.store.availableProviders;
  readonly loadingProviders = this.store.loadingProviders;
  readonly starting = this.store.starting;
  readonly synthesizing = this.store.synthesizing;
  readonly errorMessage = this.store.errorMessage;
  readonly members = this.store.members;
  readonly isRunning = this.store.isRunning;
  readonly canSynthesize = this.store.canSynthesize;
  readonly canCancel = this.store.canCancel;
  readonly synthesis = this.store.synthesis;
  readonly succeededMembers = this.store.succeededMembers;
  readonly failedMembers = this.store.failedMembers;
  readonly run = this.store.run;

  /** Members still queued or running — used to phrase the "waiting for N more" indicator. */
  readonly pendingCount = computed(
    () => this.members().length - this.succeededMembers().length - this.failedMembers().length,
  );

  // ── derived ────────────────────────────────────────────────────────────────
  readonly canStart = computed(
    () =>
      !this.starting() &&
      !this.isRunning() &&
      this.prompt().trim().length > 0 &&
      this.selectedProviders().length > 0,
  );

  readonly runHint = computed(() => {
    if (this.isRunning()) return '';
    if (this.prompt().trim().length === 0) return 'Enter a prompt first.';
    if (this.selectedProviders().length === 0) return 'Select at least one provider.';
    return `Will ask ${this.selectedProviders().length} provider${this.selectedProviders().length !== 1 ? 's' : ''}.`;
  });

  /** Providers eligible for the "pick a provider" synthesis method — only ones that answered. */
  readonly synthesisProviderChoices = computed(() => this.succeededMembers().map((m) => m.provider));

  async ngOnInit(): Promise<void> {
    await this.store.initialize();
    if (this.availableProviders().length > 0 && this.selectedProviders().length === 0) {
      this.selectedProviders.set([...this.availableProviders()]);
    }
  }

  // ── prompt / provider actions ─────────────────────────────────────────────

  onPromptInput(event: Event): void {
    this.prompt.set((event.target as HTMLTextAreaElement).value);
  }

  isSelected(provider: string): boolean {
    return this.selectedProviders().includes(provider);
  }

  toggleProvider(provider: string): void {
    const current = this.selectedProviders();
    this.selectedProviders.set(
      current.includes(provider) ? current.filter((p) => p !== provider) : [...current, provider],
    );
  }

  selectAll(): void {
    this.selectedProviders.set([...this.availableProviders()]);
  }

  clearSelection(): void {
    this.selectedProviders.set([]);
  }

  // ── run actions ────────────────────────────────────────────────────────────

  async runCouncil(): Promise<void> {
    if (!this.canStart()) return;
    await this.store.start(this.prompt().trim(), this.selectedProviders());
  }

  async cancel(): Promise<void> {
    await this.store.cancel();
  }

  clearRun(): void {
    this.store.clearRun();
  }

  // ── synthesis actions ─────────────────────────────────────────────────────

  setSynthesisChoice(choice: SynthesisChoice): void {
    this.synthesisChoice.set(choice);
    if (choice === 'provider' && !this.synthesisProviderId()) {
      this.synthesisProviderId.set(this.synthesisProviderChoices()[0] ?? null);
    }
  }

  setSynthesisProviderId(provider: string): void {
    this.synthesisProviderId.set(provider);
  }

  async synthesize(): Promise<void> {
    const method = this.resolveSynthesisMethod();
    if (!method) return;
    await this.store.synthesize(method);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  statusLabel(status: CouncilMember['status']): string {
    switch (status) {
      case 'queued':
        return 'Queued';
      case 'running':
        return 'Running…';
      case 'succeeded':
        return 'Done';
      case 'failed':
        return 'Failed';
      case 'cancelled':
        return 'Cancelled';
    }
  }

  private resolveSynthesisMethod(): CouncilSynthesisMethod | null {
    if (this.synthesisChoice() === 'consensus') return 'consensus';
    if (this.synthesisChoice() === 'debate') return 'debate';
    const providerId = this.synthesisProviderId() ?? this.synthesisProviderChoices()[0] ?? null;
    return providerId ? { providerId } : null;
  }
}
