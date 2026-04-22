import { Injectable, inject } from '@angular/core';
import { CommandStore } from '../state/command.store';
import { InstanceStore } from '../state/instance.store';
import {
  DEFAULT_KEYBINDING_ELIGIBILITY_STATE,
  KeybindingEligibilityState,
  KeybindingWhen,
  matchesKeybindingWhen,
} from '../../../../shared/types/keybinding.types';

export interface UiActionRegistration {
  id: string;
  run: () => void | Promise<void>;
  when?: KeybindingWhen[];
}

@Injectable({ providedIn: 'root' })
export class ActionDispatchService {
  private readonly commandStore = inject(CommandStore);
  private readonly instanceStore = inject(InstanceStore);
  private readonly actions = new Map<string, UiActionRegistration>();
  private state: KeybindingEligibilityState = {
    ...DEFAULT_KEYBINDING_ELIGIBILITY_STATE,
  };

  register(action: UiActionRegistration): () => void {
    this.actions.set(action.id, action);
    return () => {
      const current = this.actions.get(action.id);
      if (current === action) {
        this.actions.delete(action.id);
      }
    };
  }

  setState(patch: Partial<KeybindingEligibilityState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };
  }

  getState(): KeybindingEligibilityState {
    return this.state;
  }

  isEligible(actionId: string, extraWhen?: KeybindingWhen[]): boolean {
    const action = this.actions.get(actionId);
    return (
      matchesKeybindingWhen(action?.when, this.state) &&
      matchesKeybindingWhen(extraWhen, this.state)
    );
  }

  async dispatch(actionId: string): Promise<boolean> {
    if (actionId.startsWith('command:')) {
      return this.dispatchCommand(actionId.slice('command:'.length));
    }

    const action = this.actions.get(actionId);
    if (!action || !this.isEligible(actionId)) {
      return false;
    }

    await action.run();
    return true;
  }

  private async dispatchCommand(commandId: string): Promise<boolean> {
    const instanceId = this.instanceStore.selectedInstance()?.id;
    if (!instanceId) {
      return false;
    }

    const result = await this.commandStore.executeCommand(commandId, instanceId);
    return result.success;
  }
}
