import * as fs from 'fs/promises';
import type { SkillBundle } from '../../shared/types/skill.types';
import { parseSkillFrontmatter } from '../../shared/types/skill.types';
import type { SkillDiagnostic } from '../../shared/types/diagnostics.types';
import { getLogger } from '../logging/logger';
import { getSkillRegistry } from '../skills/skill-registry';

const logger = getLogger('SkillDiagnosticsService');

interface SkillRegistryDiagnosticsView {
  listSkills(): SkillBundle[];
  getTriggerIndex(): Map<string, string[]>;
}

export class SkillDiagnosticsService {
  private static instance: SkillDiagnosticsService | null = null;

  constructor(
    private readonly registry: SkillRegistryDiagnosticsView = getSkillRegistry(),
  ) {}

  static getInstance(): SkillDiagnosticsService {
    if (!this.instance) {
      this.instance = new SkillDiagnosticsService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  async collect(): Promise<SkillDiagnostic[]> {
    const skills = this.registry.listSkills();
    const diagnostics: SkillDiagnostic[] = [];

    diagnostics.push(...this.collectDuplicateNameDiagnostics(skills));
    diagnostics.push(...this.collectDuplicateTriggerDiagnostics(this.registry.getTriggerIndex(), skills));

    for (const skill of skills) {
      diagnostics.push(...await this.collectSkillFileDiagnostics(skill));
    }

    return diagnostics;
  }

  private collectDuplicateNameDiagnostics(skills: SkillBundle[]): SkillDiagnostic[] {
    const byName = new Map<string, SkillBundle[]>();
    for (const skill of skills) {
      const key = skill.metadata.name.toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), skill]);
    }

    return Array.from(byName.values())
      .filter((matches) => matches.length > 1)
      .map((matches) => ({
        code: 'duplicate-skill-name',
        severity: 'warning',
        message: `Multiple skills use the name "${matches[0].metadata.name}".`,
        skillName: matches[0].metadata.name,
        candidates: matches.map((skill) => skill.id),
      }));
  }

  private collectDuplicateTriggerDiagnostics(
    triggerIndex: Map<string, string[]>,
    skills: SkillBundle[],
  ): SkillDiagnostic[] {
    const byId = new Map(skills.map((skill) => [skill.id, skill]));
    const diagnostics: SkillDiagnostic[] = [];

    for (const [trigger, skillIds] of triggerIndex.entries()) {
      const uniqueIds = [...new Set(skillIds)];
      if (uniqueIds.length < 2) {
        continue;
      }

      diagnostics.push({
        code: 'duplicate-trigger',
        severity: 'warning',
        message: `Trigger "${trigger}" is claimed by ${uniqueIds.length} skills.`,
        trigger,
        candidates: uniqueIds.map((skillId) => byId.get(skillId)?.metadata.name ?? skillId),
      });
    }

    return diagnostics;
  }

  private async collectSkillFileDiagnostics(skill: SkillBundle): Promise<SkillDiagnostic[]> {
    const diagnostics: SkillDiagnostic[] = [];

    try {
      const content = await fs.readFile(skill.corePath, 'utf-8');
      if (!parseSkillFrontmatter(content)) {
        diagnostics.push({
          code: 'invalid-frontmatter',
          severity: 'error',
          message: `${skill.metadata.name} has missing or invalid SKILL.md frontmatter.`,
          skillId: skill.id,
          skillName: skill.metadata.name,
          filePath: skill.corePath,
        });
      }
    } catch (error) {
      logger.warn('Failed to read skill core file', {
        skillId: skill.id,
        corePath: skill.corePath,
        error: error instanceof Error ? error.message : String(error),
      });
      diagnostics.push({
        code: 'unreadable-file',
        severity: 'error',
        message: `${skill.metadata.name} core file could not be read.`,
        skillId: skill.id,
        skillName: skill.metadata.name,
        filePath: skill.corePath,
      });
    }

    const assetPaths = [
      ...skill.referencePaths,
      ...skill.examplePaths,
      ...skill.scriptPaths,
      ...skill.assetPaths,
    ];
    for (const filePath of assetPaths) {
      try {
        await fs.access(filePath);
      } catch {
        diagnostics.push({
          code: 'missing-file',
          severity: 'error',
          message: `${skill.metadata.name} references a missing file.`,
          skillId: skill.id,
          skillName: skill.metadata.name,
          filePath,
        });
      }
    }

    return diagnostics;
  }
}

export function getSkillDiagnosticsService(): SkillDiagnosticsService {
  return SkillDiagnosticsService.getInstance();
}

export function _resetSkillDiagnosticsServiceForTesting(): void {
  SkillDiagnosticsService._resetForTesting();
}
