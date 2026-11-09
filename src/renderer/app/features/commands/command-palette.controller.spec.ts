import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandStore, type ExtendedCommand } from '../../core/state/command.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SkillStore } from '../../core/state/skill.store';
import { UsageStore } from '../../core/state/usage.store';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { CONTROL_SURFACES } from '../../shared/control-surface/control-surface.registry';
import { NAV_ITEMS } from '../settings/settings-navigation';
import { buildDestinations } from './palette-destinations';
import { CommandPaletteController } from './command-palette.controller';

const command = (id: string, extra: Partial<ExtendedCommand> = {}): ExtendedCommand => ({
  id, name: id, description: id, template: '', builtIn: true, createdAt: 0, updatedAt: 0, ...extra,
});
describe('global command palette', () => {
  const selectedInstance = signal<{ id: string; workingDirectory: string } | null>(null);
  const commands = signal<ExtendedCommand[]>([]);
  const navigate = vi.fn().mockResolvedValue(true);
  const record = vi.fn().mockResolvedValue(undefined);
  const frecency = vi.fn<(kind: string, id: string) => number>(() => 0);
  const executeCommand = vi.fn().mockResolvedValue({ success: true });
  let controller: CommandPaletteController;
  beforeEach(() => {
    vi.clearAllMocks(); selectedInstance.set(null); commands.set([]);
    navigate.mockResolvedValue(true); frecency.mockReturnValue(0);
    TestBed.configureTestingModule({ providers: [
      { provide: Router, useValue: { navigate } },
      { provide: CommandStore, useValue: { commands, commandEligibility: () => ({ eligible: true }), executeCommand } },
      { provide: InstanceStore, useValue: { selectedInstance } },
      { provide: SkillStore, useValue: { loadSkill: vi.fn().mockResolvedValue(true) } },
      { provide: UsageStore, useValue: { record, frecency } },
      { provide: ActionDispatchService, useValue: { dispatch: vi.fn().mockResolvedValue(true) } },
      { provide: KeybindingService, useValue: { allBindings: () => [], isMac: true } },
    ] });
    controller = TestBed.inject(CommandPaletteController);
  });
  const destinations = () => controller.groups().find(g => g.id === 'go-to')!.items;
  it('finds Costs without a selected session and limits empty results to eight', () => {
    expect(destinations()).toHaveLength(8);
    controller.setQuery('cost');
    expect(destinations().map(d => d.label)).toContain('Go to Costs & Usage');
    expect(destinations().length).toBeLessThanOrEqual(12);
  });
  it('finds a page by the name of the hub it sits in', () => {
    controller.setQuery('usage & health');
    expect(destinations().map(d => d.label)).toContain('Go to Logs');
  });
  it('reaches every surface and nonduplicate settings tab by its label', () => {
    const all = buildDestinations(CONTROL_SURFACES, NAV_ITEMS);
    expect(all).toHaveLength(CONTROL_SURFACES.length + NAV_ITEMS.length - 7);
    for (const d of all) {
      controller.setQuery(d.name);
      expect(destinations().map(item => item.value.id), d.name).toContain(d.id);
    }
    for (const id of ['memory', 'remote-nodes']) {
      expect(all.some(d => d.id === id)).toBe(true);
      expect(all.some(d => d.id === `settings:${id}`)).toBe(true);
    }
  });
  it('disables session commands with a visible reason, while skills and UI remain usable', async () => {
    commands.set([command('prompt'), command('skill', { isSkill: true, skillId: 's' }),
      command('ui', { execution: { type: 'ui', actionId: 'toggle-settings' } })]);
    const items = controller.groups().filter(g => g.id !== 'go-to').flatMap(g => g.items);
    const prompt = items.find(i => i.id === 'prompt')!;
    expect(prompt.disabled).toBe(true);
    expect(prompt.disabledReason).toBe('Select a session first');
    expect(await controller.run(prompt)).toBe(false);
    expect(executeCommand).not.toHaveBeenCalled();
    for (const id of ['skill', 'ui']) expect(items.find(i => i.id === id)?.disabled).toBe(false);
    selectedInstance.set({ id: 'session', workingDirectory: '/workspace' });
    expect(controller.groups().flatMap(g => g.items).find(i => i.id === 'prompt')?.disabled).toBe(false);
  });
  it('navigates with the exact settings fragment and records successful usage', async () => {
    controller.setQuery('Go to Settings: Doctor');
    const item = destinations().find(i => i.value.id === 'settings:doctor')!;
    expect(await controller.run(item)).toBe(true);
    expect(navigate).toHaveBeenCalledWith(['/settings'], { fragment: 'doctor' });
    expect(record).toHaveBeenCalledWith('command', 'go:settings:doctor');
    record.mockClear(); navigate.mockResolvedValueOnce(false);
    expect(await controller.run(item)).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });
  it('promotes frequently used destinations ahead of everyday fallbacks', () => {
    frecency.mockImplementation((_kind, id) => id === 'go:plugins' ? 100 : 0);
    expect(destinations()[0].value.id).toBe('plugins');
  });
});
