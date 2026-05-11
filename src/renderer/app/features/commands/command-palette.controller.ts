import { Injectable, computed, inject, signal } from '@angular/core';
import { CommandStore, type ExtendedCommand } from '../../core/state/command.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SkillStore } from '../../core/state/skill.store';
import { UsageStore } from '../../core/state/usage.store';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { parseArgsFromQuery } from '../../../../shared/utils/command-args';
import type { CommandCategory } from '../../../../shared/types/command.types';
import { formatKeyBinding } from '../../../../shared/types/keybinding.types';
import type { OverlayController, OverlayGroup, OverlayItem } from '../overlay/overlay.types';
import { matchesOverlayQuery, scoreOverlayQuery } from '../../shared/utils/overlay-search';

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  review: 'Review',
  navigation: 'Navigation',
  workflow: 'Workflow',
  session: 'Session',
  orchestration: 'Orchestration',
  diagnostics: 'Diagnostics',
  memory: 'Memory',
  settings: 'Settings',
  skill: 'Skills',
  custom: 'Custom',
};

@Injectable({ providedIn: 'root' })
export class CommandPaletteController implements OverlayController<ExtendedCommand> {
  private commandStore = inject(CommandStore);
  private instanceStore = inject(InstanceStore);
  private skillStore = inject(SkillStore);
  private usageStore = inject(UsageStore);
  private actionDispatch = inject(ActionDispatchService);
  private keybindingService = inject(KeybindingService);

  readonly title: string = 'Command palette';
  readonly placeholder: string = 'Search commands...';
  readonly emptyLabel: string = 'No commands found';
  readonly query = signal('');

  readonly groups = computed<OverlayGroup<ExtendedCommand>[]>(() => {
    const query = this.query().trim().toLowerCase().replace(/^\//, '');
    const items = this.commandStore.commands()
      .filter((command) => this.matches(command, query))
      .map((command) => this.toItem(command))
      .sort((a, b) => this.score(b.value, query) - this.score(a.value, query) || a.label.localeCompare(b.label));

    const groups = new Map<CommandCategory, OverlayItem<ExtendedCommand>[]>();
    for (const item of items) {
      const category = item.value.category ?? 'custom';
      const list = groups.get(category) ?? [];
      list.push(item);
      groups.set(category, list);
    }

    return [...groups.entries()].map(([category, categoryItems]) => ({
      id: category,
      label: CATEGORY_LABELS[category],
      items: categoryItems,
    }));
  });

  setQuery(query: string): void {
    this.query.set(query);
  }

  async run(item: OverlayItem<ExtendedCommand>): Promise<boolean> {
    const command = item.value;
    const instanceId = this.instanceStore.selectedInstance()?.id;
    const args = parseArgsFromQuery(this.query(), command.name);

    if (command.isSkill && command.skillId) {
      const loaded = await this.skillStore.loadSkill(command.skillId);
      if (loaded) {
        await this.usageStore.record('command', command.id, command.skillId);
      }
      return loaded;
    }

    if (command.execution?.type === 'ui') {
      const dispatched = await this.actionDispatch.dispatch(command.execution.actionId);
      if (dispatched) {
        await this.usageStore.record('command', command.id, this.instanceStore.selectedInstance()?.workingDirectory);
      }
      return dispatched;
    }

    if (!instanceId) return false;

    const result = await this.commandStore.executeCommand(command.id, instanceId, args);
    if (result.success) {
      await this.usageStore.record('command', command.id, this.instanceStore.selectedInstance()?.workingDirectory);
    }
    return result.success;
  }

  protected toItem(command: ExtendedCommand): OverlayItem<ExtendedCommand> {
    const eligibility = this.commandStore.commandEligibility(command);
    const aliases = command.aliases?.length ? `Aliases: ${command.aliases.map((alias) => `/${alias}`).join(', ')}` : undefined;
    const commandBinding = this.keybindingService.allBindings().find(
      (b) => b.action === `command:${command.name}`,
    );
    const shortcut = commandBinding
      ? formatKeyBinding(commandBinding, this.keybindingService.isMac)
      : (command.shortcut ?? undefined);
    return {
      id: command.id,
      label: `/${command.name}`,
      description: command.description,
      detail: command.usage ?? aliases,
      badge: command.isSkill ? 'Skill' : command.builtIn ? 'Built-in' : command.category,
      shortcut,
      disabled: !eligibility.eligible,
      disabledReason: eligibility.reason,
      keywords: [command.name, command.description, ...(command.aliases ?? []), command.category ?? ''],
      value: command,
    };
  }

  private matches(command: ExtendedCommand, query: string): boolean {
    return matchesOverlayQuery([
      command.name,
      command.description,
      command.category ?? '',
      command.usage ?? '',
      ...(command.aliases ?? []),
      ...(command.examples ?? []),
    ], query);
  }

  private score(command: ExtendedCommand, query: string): number {
    const name = command.name.toLowerCase();
    const aliases = (command.aliases ?? []).map((alias) => alias.toLowerCase());
    let score = this.usageStore.frecency('command', command.id) * 10;
    if (command.rankHints?.pinned) score += 1000;
    if (query) {
      score += scoreOverlayQuery([command.name, command.description, command.category ?? ''], query) * 5;
      const q = query.toLowerCase();
      if (name === q) score += 500;
      else if (name.startsWith(q)) score += 300;
      if (aliases.includes(q)) score += 450;
      else if (aliases.some((alias) => alias.startsWith(q))) score += 220;
    }
    score += (command.rankHints?.weight ?? 1) * 10;
    return score;
  }
}
