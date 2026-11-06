import { computed } from '@angular/core';
import type { ContextWarningLevel } from '../../features/instance-detail/context-warning-level';
import type { InstanceStore } from '../../core/state/instance.store';
import type { LoopStore } from '../../core/state/loop.store';
import type { SettingsStore } from '../../core/state/settings.store';
import type { InputPanelComponent } from '../../features/instance-detail/input-panel.component';
import type { WorkingTipRuntime } from './working-tip.service';

/**
 * The compact-preview tip may only be offered while its real control is
 * available: the context warning's "Preview" / "Compact Now" actions
 * (`app-context-warning` → `onPreviewCompaction`) are on screen exactly while
 * the banner shows — a real occupancy-pressure reading on a provider that does
 * not self-manage auto-compaction, with no compaction running and the warning
 * not dismissed. `InstanceDetailComponent` feeds this from its live banner
 * state so the tip can never advertise a control the user cannot reach.
 */
export function isCompactionPreviewControlAvailable(
  level: ContextWarningLevel | null,
  dismissed: boolean,
  compacting: boolean,
): boolean {
  return level !== null && !dismissed && !compacting;
}

/** Read the live composer signal so paste/edit/restore hide the tip immediately. */
export function createWorkingTipRuntime(
  instances: InstanceStore, settings: SettingsStore, loops: LoopStore,
  readComposer: () => InputPanelComponent | undefined,
  readCompactPreviewControl: () => boolean,
) {
  const loop = computed(() => {
    const id = instances.selectedInstanceIdentity();
    return id ? loops.activeForChat(id) : null;
  });
  return computed<WorkingTipRuntime | null>(() => {
    const instance = instances.selectedInstance();
    if (!instance) return null;
    const composer = readComposer();
    return {
      sessionId: instance.id, busySince: instances.getSelectedInstanceBusySince() ?? null,
      enabled: settings.settings().showWorkingTips,
      composerText: composer ? composer.message() : 'Composer loading',
      queuedCount: instances.getQueuedMessageCount(instance.id), activeLoop: Boolean(loop()?.()),
      sessionCount: instances.instances().length, hasReply: instance.outputBuffer.some((message) => message.type === 'assistant'),
      contextPercentage: instance.contextUsage.occupancyReported && !instance.contextUsage.occupancyIsAggregate ? instance.contextUsage.percentage : 0,
      compactPreviewAvailable: readCompactPreviewControl(),
    };
  });
}
