import type { SkillBundle } from '../../shared/types/skill.types';
import type {
  SkillControlMode,
  SkillControlRecord,
  SkillHealthCatalogEntry,
} from '../../shared/types/skill-observability.types';

/** Registry rows remain controllable even before a skill has ever injected. */
export function buildSkillHealthCatalog(
  bundles: readonly SkillBundle[],
  controls: readonly SkillControlRecord[],
  sourceFor: (path: string) => SkillHealthCatalogEntry['source'],
  defaultModeFor: (source: SkillHealthCatalogEntry['source']) => SkillControlMode,
): SkillHealthCatalogEntry[] {
  const overrides = new Map(controls.map((control) => [control.skillName, control.mode]));
  const entries = new Map<string, SkillHealthCatalogEntry>();
  for (const bundle of bundles) {
    const skillName = bundle.metadata.name;
    const source = sourceFor(bundle.path);
    entries.set(skillName, {
      skillName,
      source,
      effectiveMode: overrides.get(skillName) ?? defaultModeFor(source),
    });
  }
  return [...entries.values()];
}
