import type { ExtendedCommand } from '../../core/state/command.store';
import type { ControlSurfaceItem } from '../../shared/control-surface/control-surface.types';
import type { SettingsNavItem } from '../settings/settings-navigation';

export interface PaletteDestination extends ExtendedCommand {
  destination: { path: string; fragment?: string };
  keywords: string[];
}

export function buildDestinations(
  surfaces: readonly ControlSurfaceItem[], settingsTabs: readonly SettingsNavItem[],
): PaletteDestination[] {
  const duplicates = new Set(surfaces.filter(surface => surface.showInSettingsNav).map(surface => surface.id as string));
  const entry = (id: string, name: string, description: string, keywords: string[],
    destination: PaletteDestination['destination']): PaletteDestination => ({
    id, name, description, keywords, destination,
    template: '', builtIn: true, category: 'navigation', createdAt: 0, updatedAt: 0,
  });
  return [
    ...surfaces.map(surface => entry(surface.id, `Go to ${surface.label}`, surface.subtitle ?? '',
      [surface.label, surface.group], { path: surface.path })),
    ...settingsTabs.filter(tab => !duplicates.has(tab.id)).map(tab => entry(`settings:${tab.id}`,
      `Go to Settings: ${tab.label}`, tab.summary, [tab.label, tab.keywords ?? '', tab.group ?? ''],
      { path: '/settings', fragment: tab.id })),
  ];
}
