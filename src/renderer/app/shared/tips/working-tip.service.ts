import { DOCUMENT } from '@angular/common';
import { Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { KeybindingService } from '../../core/services/keybinding.service';
import { FeatureUsageService } from './feature-usage.service';
import { WORKING_TIPS, type TipRelevance, type WorkingTip } from './tip-catalogue';
import { pickTip, tipEnvironmentEligible, type TipContext } from './tip-policy';

export interface WorkingTipRuntime extends TipRelevance {
  sessionId: string;
  busySince: number | null;
  enabled: boolean;
  composerText: string;
  queuedCount: number;
  activeLoop: boolean;
}

@Injectable({ providedIn: 'root' })
export class WorkingTipService {
  private readonly usage = inject(FeatureUsageService);
  private readonly keys = inject(KeybindingService);
  private readonly document = inject(DOCUMENT);
  private shownThisLaunch = 0;
  private lastShownAt: number | null = null;
  private previousTipId: string | null = null;
  private readonly renderedPeriods = new Set<string>();
  private readonly lastInteractionAt = signal<number | null>(null);

  /** Only the main session's working row connects; teardown follows its view. */
  connect(readRuntime: () => WorkingTipRuntime | null, injector: Injector) {
    // A newly visible view has no reliable recent-input history yet.
    this.lastInteractionAt.set(Date.now());
    const now = signal(Date.now());
    const modalOpen = signal(false);
    const syncModalState = () => modalOpen.set(Boolean(this.document.querySelector('[role="dialog"][aria-modal="true"]'))
      || this.document.visibilityState === 'hidden');
    syncModalState();
    const selected = signal<{ period: string; tip: WorkingTip } | null>(null);
    const runningPeriod = computed(() => {
      const runtime = readRuntime();
      return runtime?.enabled && runtime.busySince !== null ? `${runtime.sessionId}:${runtime.busySince}` : null;
    });
    const context = computed<TipContext | null>(() => {
      const runtime = readRuntime();
      if (!runtime) return null;
      const shortcuts: Record<string, string> = {};
      for (const entry of WORKING_TIPS) {
        if (entry.shortcutActionId) shortcuts[entry.shortcutActionId] = this.keys.formatBindingByAction(entry.shortcutActionId);
      }
      return { ...runtime, now: now(), lastKeystrokeAt: this.lastInteractionAt(),
        modalOpen: modalOpen(),
        shownThisLaunch: this.shownThisLaunch, lastShownAt: this.lastShownAt,
        previousTipId: this.previousTipId, shownThisBusyPeriod: this.renderedPeriods.has(`${runtime.sessionId}:${runtime.busySince}`),
        usedCounts: this.usage.usedCounts(), shownCounts: this.usage.shownCounts(), shortcuts };
    });
    const tip = computed(() => {
      const current = selected(); const ctx = context();
      if (!current || !ctx || current.period !== runningPeriod() || !tipEnvironmentEligible(ctx)
        || this.usage.count(current.tip.featureId) > 0
        || (current.tip.shortcutActionId && !ctx.shortcuts[current.tip.shortcutActionId])
        || (current.tip.relevantWhen && !current.tip.relevantWhen(ctx))) return null;
      const key = current.tip.shortcutActionId ? ctx.shortcuts[current.tip.shortcutActionId] : '';
      return { ...current.tip, text: current.tip.text.replace('{key}', key) };
    });
    const timerEffect = effect((onCleanup) => {
      if (!runningPeriod()) return;
      untracked(() => now.set(Date.now()));
      const timer = setInterval(() => now.set(Date.now()), 1_000);
      onCleanup(() => clearInterval(timer));
    }, { injector });
    const selectionEffect = effect(() => {
      const ctx = context(); const period = runningPeriod();
      if (selected()) {
        if (!tip()) selected.set(null);
        return;
      }
      if (ctx && period) {
        const candidate = pickTip(ctx, WORKING_TIPS);
        if (candidate) selected.set({ period, tip: candidate });
      }
    }, { injector });
    const interacted = (event: Event) => {
      // Tab must still reach Got it, and activating that button is not typing.
      if (event instanceof KeyboardEvent && (event.key === 'Tab'
        || (event.target instanceof Element && event.target.closest('app-working-tip')))) return;
      this.lastInteractionAt.set(Date.now()); now.set(Date.now());
      if (event.type === 'visibilitychange') syncModalState();
    };
    this.document.addEventListener('keydown', interacted, true);
    this.document.addEventListener('visibilitychange', interacted);
    // Dialogs can open between ticks; hide an existing line immediately.
    // Streaming transcript changes do not affect eligibility. Only dialog changes
    // require a fresh lookup, and an unchanged boolean does not invalidate the tip.
    const containsDialog = (node: Node) => node instanceof Element
      && (node.matches('[role="dialog"]') || Boolean(node.querySelector('[role="dialog"]')));
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.type === 'attributes'
        || [...record.addedNodes, ...record.removedNodes].some(containsDialog))) syncModalState();
    });
    observer.observe(this.document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal'] });
    return {
      tip,
      markRendered: (tipId: string) => {
        const current = selected();
        if (!current || current.tip.id !== tipId || !tip() || this.renderedPeriods.has(current.period)) return;
        this.renderedPeriods.add(current.period);
        this.shownThisLaunch += 1; this.lastShownAt = Date.now(); this.previousTipId = tipId;
        this.usage.markShown(tipId);
      },
      retire: () => { const current = selected(); if (current) this.usage.retire(current.tip.id); selected.set(null); },
      destroy: () => {
        timerEffect.destroy(); selectionEffect.destroy(); observer.disconnect();
        this.document.removeEventListener('keydown', interacted, true);
        this.document.removeEventListener('visibilitychange', interacted);
      },
    };
  }
}
