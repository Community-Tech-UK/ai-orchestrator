import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import type { InstanceStore } from '../../core/state/instance.store';
import type { SettingsStore } from '../../core/state/settings.store';
import type { LoopStore } from '../../core/state/loop.store';
import type { InputPanelComponent } from '../../features/instance-detail/input-panel.component';
import type { ContextWarningLevel } from '../../features/instance-detail/context-warning-level';
import { createWorkingTipRuntime, isCompactionPreviewControlAvailable } from './working-tip-runtime';

describe('main-session working tip context', () => {
  it('reads live composer changes, queue and loop state', () => {
    const message = signal('');
    const composer = signal<InputPanelComponent | undefined>(undefined);
    const queue = signal(0); const loop = signal<unknown>(undefined);
    const settings = signal({ showWorkingTips: true });
    const instance = { id: 'session-1', outputBuffer: [{ type: 'assistant', content: 'Answer' }],
      contextUsage: { percentage: 80, occupancyReported: true } };
    const runtime = createWorkingTipRuntime({
      selectedInstanceIdentity: () => 'session-1', selectedInstance: () => instance,
      getSelectedInstanceBusySince: () => 1_000, instances: () => [instance], getQueuedMessageCount: () => queue(),
    } as unknown as InstanceStore, { settings } as unknown as SettingsStore,
    { activeForChat: () => loop } as unknown as LoopStore, () => composer(), () => true);
    // Missing composer is not evidence of an empty draft.
    expect(runtime()?.composerText.length).toBeGreaterThan(0);
    composer.set({ message } as unknown as InputPanelComponent);
    expect(runtime()?.composerText).toBe('');
    message.set('pasted draft'); expect(runtime()?.composerText).toBe('pasted draft');
    queue.set(1); loop.set({ id: 'loop-1' }); settings.set({ showWorkingTips: false });
    expect(runtime()).toMatchObject({ queuedCount: 1, activeLoop: true, enabled: false,
      hasReply: true, contextPercentage: 80, compactPreviewAvailable: true });
  });

  it('reflects the live compaction-preview control state in the tip runtime', () => {
    const controlReady = signal(false);
    const instance = { id: 'session-1', outputBuffer: [{ type: 'assistant', content: 'Answer' }],
      contextUsage: { percentage: 80, occupancyReported: true } };
    const runtime = createWorkingTipRuntime({
      selectedInstanceIdentity: () => 'session-1', selectedInstance: () => instance,
      getSelectedInstanceBusySince: () => 1_000, instances: () => [instance], getQueuedMessageCount: () => 0,
    } as unknown as InstanceStore, { settings: signal({ showWorkingTips: true }) } as unknown as SettingsStore,
    { activeForChat: () => signal(undefined) } as unknown as LoopStore,
    () => ({ message: signal('') } as unknown as InputPanelComponent), () => controlReady());
    expect(runtime()?.compactPreviewAvailable).toBe(false);
    controlReady.set(true);
    expect(runtime()?.compactPreviewAvailable).toBe(true);
    controlReady.set(false);
    expect(runtime()?.compactPreviewAvailable).toBe(false);
  });
});

describe('isCompactionPreviewControlAvailable', () => {
  it('is true only while the context warning preview actions are on screen', () => {
    expect(isCompactionPreviewControlAvailable('warning', false, false)).toBe(true);
    expect(isCompactionPreviewControlAvailable('critical', false, false)).toBe(true);
    expect(isCompactionPreviewControlAvailable('emergency', false, false)).toBe(true);
  });
  it.each<[string, ContextWarningLevel | null, boolean, boolean]>([
    ['no banner (self-managing provider, unknown/aggregate reading, or under the threshold)', null, false, false],
    ['the warning is dismissed', 'warning', true, false],
    ['a compaction is running', 'warning', false, true],
  ])('is false while %s', (_case, level, dismissed, compacting) => {
    expect(isCompactionPreviewControlAvailable(level, dismissed, compacting)).toBe(false);
  });
});
