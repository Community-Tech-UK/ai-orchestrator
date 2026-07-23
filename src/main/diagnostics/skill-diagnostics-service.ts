import * as fs from 'fs/promises';
import type { SkillBundle } from '../../shared/types/skill.types';
import { parseSkillFrontmatter, parseSkillMetadata, validateSkillName } from '../skills/skill-spec';
import type { SkillDiagnostic } from '../../shared/types/diagnostics.types';
import { getLogger } from '../logging/logger';
import { getSkillRegistry } from '../skills/skill-registry';
import {
  checkSkillToolCapabilities,
  describeSkillToolMismatch,
} from '../skills/skill-tool-capability-check';
import { createBrowserMcpTools } from '../browser-gateway/browser-mcp-tools';
import { createDesktopMcpTools } from '../desktop-gateway/desktop-mcp-tools';

const logger = getLogger('SkillDiagnosticsService');

/**
 * The managed MCP tools injected into agent sessions. Built from the same
 * factories the forwarders register, so the diagnostic can never drift from the
 * surface it is checking against.
 */
function defaultExposedToolNames(): string[] {
  const noopClient = { call: async () => null };
  return [
    ...createBrowserMcpTools(noopClient).map((tool) => tool.name),
    ...createDesktopMcpTools(noopClient).map((tool) => tool.name),
  ];
}

interface SkillRegistryDiagnosticsView {
  listSkills(): SkillBundle[];
  getTriggerIndex(): Map<string, string[]>;
}

export class SkillDiagnosticsService {
  private static instance: SkillDiagnosticsService | null = null;

  constructor(
    private readonly registry: SkillRegistryDiagnosticsView = getSkillRegistry(),
    /** The managed tool surface agent sessions actually receive. */
    private readonly exposedToolNames: () => string[] = defaultExposedToolNames,
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
      diagnostics.push(...this.collectLintDiagnostics(skill));
      diagnostics.push(...await this.collectSkillFileDiagnostics(skill));
    }

    return diagnostics;
  }

  /**
   * Static lint: cheap heuristics that catch the "silently bad skill" shapes —
   * over-broad triggers, weak descriptions, and oversized cores.
   */
  private collectLintDiagnostics(skill: SkillBundle): SkillDiagnostic[] {
    const diagnostics: SkillDiagnostic[] = [];
    const { name, description, triggers, coreSize } = skill.metadata;

    for (const trigger of triggers) {
      if (trigger.startsWith('/')) continue; // slash commands are typed deliberately
      const normalized = trigger.trim().toLowerCase();
      const isSingleShortWord = !normalized.includes(' ') && normalized.length < 6;
      if (isSingleShortWord) {
        diagnostics.push({
          code: 'over-broad-trigger',
          severity: 'warning',
          message: `${name} trigger "${trigger}" is a single short word and will fire on unrelated messages.`,
          skillId: skill.id,
          skillName: name,
          trigger,
        });
      }
    }

    if (!description || description.trim().length < 40) {
      diagnostics.push({
        code: 'weak-description',
        severity: 'warning',
        message: `${name} has a description under 40 characters — too weak for semantic matching or review.`,
        skillId: skill.id,
        skillName: name,
      });
    }

    const OVERSIZED_CORE_BYTES = 16_000; // ~4k tokens of always-injected content
    if ((coreSize ?? 0) > OVERSIZED_CORE_BYTES) {
      diagnostics.push({
        code: 'oversized-core',
        severity: 'warning',
        message: `${name} core is ${Math.round((coreSize ?? 0) / 1000)}k chars (~${Math.round((coreSize ?? 0) / 4000)}k tokens) — it will tax the context budget on every activation.`,
        skillId: skill.id,
        skillName: name,
        filePath: skill.corePath,
      });
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

  /**
   * Skill instructions that mandate a tool this build does not expose are
   * unusable, and fail in a confusing way at runtime rather than at install
   * time. Reported as an error with the managed alternative named.
   */
  private collectToolSurfaceDiagnostics(
    skill: SkillBundle,
    content: string,
  ): SkillDiagnostic[] {
    return checkSkillToolCapabilities({
      skills: [{ bundle: skill, coreContent: content }],
      exposedToolNames: this.exposedToolNames(),
    }).map((mismatch) => ({
      code: 'tool-surface-mismatch' as const,
      severity: 'error' as const,
      message: describeSkillToolMismatch(mismatch),
      skillId: skill.id,
      skillName: skill.metadata.name,
      filePath: skill.corePath,
    }));
  }

  private async collectSkillFileDiagnostics(skill: SkillBundle): Promise<SkillDiagnostic[]> {
    const diagnostics: SkillDiagnostic[] = [];

    try {
      const content = await fs.readFile(skill.corePath, 'utf-8');
      diagnostics.push(...this.collectToolSurfaceDiagnostics(skill, content));
      const metadata = parseSkillMetadata(content, skill.metadata.name);
      const nameOk = validateSkillName(metadata.name).ok;
      // Trigger-less skills are valid (embedding-only, suggest-only default) —
      // only a missing frontmatter block or invalid name is a defect.
      if (!parseSkillFrontmatter(content) || !nameOk) {
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
