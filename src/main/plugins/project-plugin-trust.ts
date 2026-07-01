import * as path from 'path';
import type { ProjectPluginTrust } from '../../shared/types/settings.types';
import type { PluginManifest } from '@sdk/plugins';
import type {
  PluginLoadReport,
  PluginPhaseResult,
  PluginSlot,
} from '../../shared/types/plugin.types';

export type { ProjectPluginTrust };

export interface ProjectPluginTrustDecision {
  readonly trust: ProjectPluginTrust;
  readonly reason: string;
  readonly projectRoot: string;
}

export function buildProjectPluginTrustSkipReport(
  slot: PluginSlot,
  phases: readonly PluginPhaseResult[],
  decision: ProjectPluginTrustDecision,
  buildPhase: (
    phase: PluginPhaseResult['phase'],
    status: PluginPhaseResult['status'],
    message?: string,
  ) => PluginPhaseResult,
): PluginLoadReport {
  const message = `${decision.reason} Grant trust before importing plugin code.`;
  return {
    slot,
    detected: false,
    ready: false,
    phases: [
      ...phases,
      buildPhase('instantiation', 'skipped', message),
      buildPhase('detect', 'skipped', message),
      buildPhase('slot_registration', 'skipped', message),
      buildPhase('ready', 'skipped', message),
    ],
  };
}

export function buildProjectPluginTrustSkippedPlugin(
  filePath: string,
  manifest: PluginManifest | undefined,
  phases: readonly PluginPhaseResult[],
  decision: ProjectPluginTrustDecision,
  buildPhase: (
    phase: PluginPhaseResult['phase'],
    status: PluginPhaseResult['status'],
    message?: string,
  ) => PluginPhaseResult,
): {
  filePath: string;
  hooks: Record<string, never>;
  slot: PluginSlot;
  manifest?: PluginManifest;
  loadReport: PluginLoadReport;
} {
  const slot = manifest?.slot ?? 'hook';
  return {
    filePath,
    hooks: {},
    slot,
    manifest,
    loadReport: buildProjectPluginTrustSkipReport(slot, phases, decision, buildPhase),
  };
}

const TRUST_VALUES = new Set<ProjectPluginTrust>(['trusted', 'untrusted', 'ask']);

export function canonicalizeProjectPluginRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function resolveProjectPluginTrust(
  projectRoot: string,
  settings: unknown,
): ProjectPluginTrustDecision {
  const canonicalRoot = canonicalizeProjectPluginRoot(projectRoot);
  const trust = readTrustDecision(canonicalRoot, settings);
  if (trust === 'trusted') {
    return {
      projectRoot: canonicalRoot,
      trust,
      reason: 'Project plugin root is trusted in settings.',
    };
  }
  if (trust === 'untrusted') {
    return {
      projectRoot: canonicalRoot,
      trust,
      reason: 'Project plugin root is rejected in settings.',
    };
  }
  return {
    projectRoot: canonicalRoot,
    trust: 'ask',
    reason: 'No trust decision recorded for project plugins at this root.',
  };
}

function readTrustDecision(
  canonicalRoot: string,
  settings: unknown,
): ProjectPluginTrust {
  if (!isRecord(settings)) {
    return 'ask';
  }
  const trustMap = settings['projectPluginTrust'];
  if (!isRecord(trustMap)) {
    return 'ask';
  }
  for (const [rawRoot, rawTrust] of Object.entries(trustMap)) {
    if (!TRUST_VALUES.has(rawTrust as ProjectPluginTrust)) {
      continue;
    }
    if (canonicalizeProjectPluginRoot(rawRoot) === canonicalRoot) {
      return rawTrust as ProjectPluginTrust;
    }
  }
  return 'ask';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
