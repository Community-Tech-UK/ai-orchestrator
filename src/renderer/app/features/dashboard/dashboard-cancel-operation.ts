/**
 * The Escape / cancel-operation cascade for the dashboard: close the topmost
 * transient overlay if one is open, otherwise interrupt the selected running
 * instance. Extracted from `DashboardComponent` so the priority order is
 * readable (and the component stays under the file-size ratchet).
 */

import type { WritableSignal } from '@angular/core';
import type { Instance } from '../../core/state/instance/instance.types';

export interface CancelOperationHost {
  showCommandPalette: WritableSignal<boolean>;
  showCommandHelp: WritableSignal<boolean>;
  showSessionPicker: WritableSignal<boolean>;
  showPromptHistorySearch: WritableSignal<boolean>;
  showHistory: WritableSignal<boolean>;
  selectedInstance: () => Instance | null;
  interruptInstance: (instanceId: string) => Promise<unknown> | void;
}

const INTERRUPTIBLE_STATUSES: readonly Instance['status'][] = [
  'busy',
  'respawning',
  'interrupting',
  'cancelling',
  'interrupt-escalating',
];

export function runCancelOperationCascade(host: CancelOperationHost): void {
  const overlays = [
    host.showCommandPalette,
    host.showCommandHelp,
    host.showSessionPicker,
    host.showPromptHistorySearch,
    host.showHistory,
  ];
  for (const overlay of overlays) {
    if (overlay()) {
      overlay.set(false);
      return;
    }
  }

  const instance = host.selectedInstance();
  if (instance && INTERRUPTIBLE_STATUSES.includes(instance.status)) {
    void host.interruptInstance(instance.id);
  }
}
