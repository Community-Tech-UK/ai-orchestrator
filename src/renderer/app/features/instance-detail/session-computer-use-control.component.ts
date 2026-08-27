import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';
import type { Instance } from '../../core/state/instance.store';
import {
  COMPUTER_USE_AUTONOMY_LEVELS,
  type ComputerUseAutonomyLevel,
} from '../../../../shared/types/desktop-gateway-settings.types';

export interface ComputerUsePresentation {
  effectiveLevel: ComputerUseAutonomyLevel;
  selection: ComputerUseAutonomyLevel | 'global';
  relation: 'global' | 'session' | 'elevated' | 'lowered';
}

export function resolveComputerUsePresentation(
  mode: ComputerUseAutonomyLevel | undefined,
  globalLevel: ComputerUseAutonomyLevel,
): ComputerUsePresentation {
  if (!mode) {
    return { effectiveLevel: globalLevel, selection: 'global', relation: 'global' };
  }
  const rank: Record<ComputerUseAutonomyLevel, number> = {
    guarded: 0,
    trusted: 1,
    unrestricted: 2,
  };
  return {
    effectiveLevel: mode,
    selection: mode,
    relation: rank[mode] === rank[globalLevel]
      ? 'session'
      : rank[mode] > rank[globalLevel] ? 'elevated' : 'lowered',
  };
}

@Component({
  selector: 'app-session-computer-use-control',
  standalone: true,
  templateUrl: './session-computer-use-control.component.html',
  styleUrl: './session-computer-use-control.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionComputerUseControlComponent {
  private readonly electronIpc = inject(ElectronIpcService);
  private readonly settingsStore = inject(SettingsStore);

  readonly instance = input.required<Pick<Instance, 'id' | 'computerUseMode'>>();
  readonly pending = signal(false);
  readonly error = signal<string | null>(null);
  readonly globalLevel = computed<ComputerUseAutonomyLevel>(() => {
    const value = this.settingsStore.settings().computerUseAutonomyLevel;
    return COMPUTER_USE_AUTONOMY_LEVELS.includes(value) ? value : 'trusted';
  });
  readonly presentation = computed(() => resolveComputerUsePresentation(
    this.instance().computerUseMode,
    this.globalLevel(),
  ));
  readonly descriptionId = computed(() => `computer-use-description-${this.instance().id}`);
  readonly errorId = computed(() => `computer-use-error-${this.instance().id}`);
  readonly title = computed(() => {
    const state = this.presentation();
    const source = state.selection === 'global' ? 'global default' : 'session override';
    const relation = state.relation === 'elevated'
      ? ' Elevated permissions are active for this session.'
      : state.relation === 'lowered'
        ? ' This session is more restricted than the global default.'
        : '';
    const error = this.error();
    return `Computer Use: ${state.effectiveLevel} (${source}). Changes apply to the next call, need no restart, and end with the session.${relation}${error ? ` Last change failed: ${error}` : ''}`;
  });

  async changeMode(event: Event): Promise<void> {
    const selection = (event.target as HTMLSelectElement).value;
    const mode = selection === 'global' ? null : selection as ComputerUseAutonomyLevel;
    this.pending.set(true);
    this.error.set(null);
    try {
      const response = await this.electronIpc.getApi()?.setComputerUseMode({
        instanceId: this.instance().id,
        mode,
      });
      if (!response?.success) {
        this.error.set(response?.error?.message ?? 'Computer Use mode could not be changed');
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.pending.set(false);
    }
  }
}
