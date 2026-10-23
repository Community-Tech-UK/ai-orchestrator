import type { ControlSurfaceId } from '../control-surface/control-surface.types';
import type { GlossaryTermId } from '../glossary/glossary';
import { CONTROL_SURFACE_HELP } from './control-surface-help';
import { getControlSurface } from '../control-surface/control-surface-nav';
import { HELP_TOPICS, type HelpTopicId } from './help-topics';
import type { HelpEntry } from './help-content.types';

export type HelpTarget =
  | { topic: HelpTopicId; anchor?: GlossaryTermId }
  | { surface: ControlSurfaceId };

export function resolveHelpTarget(target: HelpTarget): { title: string; entry: HelpEntry; anchor?: string } {
  if ('surface' in target) {
    return { title: getControlSurface(target.surface).label, entry: CONTROL_SURFACE_HELP[target.surface] };
  }
  return { ...HELP_TOPICS[target.topic], anchor: target.anchor };
}
