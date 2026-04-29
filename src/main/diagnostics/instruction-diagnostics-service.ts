import * as path from 'path';
import {
  resolveInstructionStack,
  type ResolveInstructionStackParams,
} from '../core/config/instruction-resolver';
import type { InstructionDiagnostic } from '../../shared/types/diagnostics.types';
import type { InstructionResolution } from '../../shared/types/instruction-source.types';
import { getLogger } from '../logging/logger';
import { countRepoFiles } from './count-repo-files';

const logger = getLogger('InstructionDiagnosticsService');

type ResolveFn = (params: ResolveInstructionStackParams) => Promise<InstructionResolution>;
type CountFn = (root: string, options?: { stopAfter?: number }) => Promise<number>;

export interface InstructionDiagnosticsOptions {
  workingDirectory: string;
  contextPaths?: string[];
  broadRootFileThreshold?: number;
}

export class InstructionDiagnosticsService {
  private static instance: InstructionDiagnosticsService | null = null;

  constructor(
    private readonly resolver: ResolveFn = resolveInstructionStack,
    private readonly countFiles: CountFn = countRepoFiles,
  ) {}

  static getInstance(): InstructionDiagnosticsService {
    if (!this.instance) {
      this.instance = new InstructionDiagnosticsService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  async collect(options: InstructionDiagnosticsOptions): Promise<InstructionDiagnostic[]> {
    try {
      const resolution = await this.resolver({
        workingDirectory: options.workingDirectory,
        contextPaths: options.contextPaths,
      });
      const diagnostics: InstructionDiagnostic[] = [
        ...this.mapResolverWarnings(resolution),
        ...this.collectConflictDiagnostics(resolution),
        ...await this.collectBroadRootDiagnostics(
          resolution,
          options.broadRootFileThreshold ?? 100,
        ),
      ];

      return this.dedupeDiagnostics(diagnostics);
    } catch (error) {
      logger.warn('Failed to resolve instructions for diagnostics', {
        workingDirectory: options.workingDirectory,
        error: error instanceof Error ? error.message : String(error),
      });
      return [{
        code: 'resolution-failed',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
      }];
    }
  }

  private mapResolverWarnings(resolution: InstructionResolution): InstructionDiagnostic[] {
    return resolution.warnings.map((warning) => {
      if (warning.includes('Multiple path-specific')) {
        return {
          code: 'multiple-path-specific-instructions',
          severity: 'warning',
          message: warning,
        };
      }

      return {
        code: 'conflicting-instruction-sources',
        severity: 'warning',
        message: warning,
      };
    });
  }

  private collectConflictDiagnostics(resolution: InstructionResolution): InstructionDiagnostic[] {
    const loadedProjectSources = resolution.sources.filter(
      (source) => source.loaded && source.scope === 'project',
    );
    const loadedKinds = new Set(loadedProjectSources.map((source) => source.kind));
    const diagnostics: InstructionDiagnostic[] = [];

    if (
      loadedKinds.has('copilot') &&
      (loadedKinds.has('agents') || loadedKinds.has('orchestrator'))
    ) {
      diagnostics.push({
        code: 'conflicting-instruction-sources',
        severity: 'warning',
        message: 'Copilot instructions are present alongside AGENTS or orchestrator project instructions.',
        candidates: loadedProjectSources
          .filter((source) => ['copilot', 'agents', 'orchestrator'].includes(source.kind))
          .map((source) => source.path),
      });
    }

    return diagnostics;
  }

  private async collectBroadRootDiagnostics(
    resolution: InstructionResolution,
    threshold: number,
  ): Promise<InstructionDiagnostic[]> {
    if (threshold <= 0) {
      return [];
    }

    const broadProjectInstructions = resolution.sources.filter((source) =>
      source.loaded &&
      source.applied &&
      source.scope === 'project' &&
      source.kind === 'orchestrator' &&
      path.basename(source.path).toUpperCase() === 'INSTRUCTIONS.MD'
    );
    if (broadProjectInstructions.length === 0) {
      return [];
    }

    const fileCount = await this.countFiles(resolution.projectRoot, { stopAfter: threshold });
    if (fileCount <= threshold) {
      return [];
    }

    return broadProjectInstructions.map((source) => ({
      code: 'broad-root-scan',
      severity: 'warning',
      message: `Project-level instructions apply to ${fileCount}+ files without path-specific scope.`,
      filePath: source.path,
      sourceKind: source.kind,
      sourceScope: source.scope,
    }));
  }

  private dedupeDiagnostics(diagnostics: InstructionDiagnostic[]): InstructionDiagnostic[] {
    const seen = new Set<string>();
    return diagnostics.filter((diagnostic) => {
      const key = [
        diagnostic.code,
        diagnostic.message,
        diagnostic.filePath ?? '',
        diagnostic.candidates?.join('|') ?? '',
      ].join('\0');
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}

export function getInstructionDiagnosticsService(): InstructionDiagnosticsService {
  return InstructionDiagnosticsService.getInstance();
}

export function _resetInstructionDiagnosticsServiceForTesting(): void {
  InstructionDiagnosticsService._resetForTesting();
}
