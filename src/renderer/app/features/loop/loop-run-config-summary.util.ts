import { formatCostCents, humanDuration, humanTokens } from './loop-formatters.util';

export function iterationCapLabel(maxIterations: number | null): string {
  return maxIterations === null ? '∞' : String(maxIterations);
}

export function buildRunConfigSummary(loop: {
  manualReviewOnly: boolean;
  lastIteration?: { model?: string } | null;
  config: {
    provider: string;
    contextStrategy: string;
    initialStage: string;
    caps: {
      maxIterations: number | null;
      maxWallTimeMs: number;
      maxTokens: number | null;
      maxCostCents: number | null;
    };
    completion: {
      verifyCommand?: string | null;
      requireCompletedFileRename?: boolean;
      runVerifyTwice?: boolean;
      crossModelReview?: { enabled?: boolean } | null;
    };
    context?: { compaction: { enabled?: boolean } } | null;
    exploration?: { enabled?: boolean } | null;
    plan?: { regenerateOnStall?: boolean } | null;
    semanticProgress?: { enabled?: boolean } | null;
    allowDestructiveOps?: boolean;
  };
} | null | undefined): { label: string; value: string }[] {
  if (!loop) return [];
  const c = loop.config;
  const cost = c.caps.maxCostCents === null ? 'no cap' : formatCostCents(c.caps.maxCostCents);
  const tokenCap = c.caps.maxTokens === null ? 'no token cap' : humanTokens(c.caps.maxTokens);
  const flags: string[] = [];
  if (c.completion.requireCompletedFileRename) flags.push('rename-gate');
  if (c.completion.runVerifyTwice) flags.push('verify×2');
  if (c.completion.crossModelReview?.enabled) flags.push('fresh-eyes');
  if (c.context?.compaction.enabled) flags.push('context-recycle');
  if (c.exploration?.enabled) flags.push('branch-select');
  if (c.plan?.regenerateOnStall) flags.push('regen-on-stall');
  if (c.semanticProgress?.enabled) flags.push('semantic-progress');
  if (c.allowDestructiveOps) flags.push('destructive-ops');
  return [
    { label: 'Provider', value: loop.lastIteration?.model ? `${c.provider} · ${loop.lastIteration.model}` : c.provider },
    { label: 'Context', value: c.contextStrategy },
    { label: 'Start stage', value: c.initialStage },
    { label: 'Caps', value: `${iterationCapLabel(c.caps.maxIterations)} iters · ${humanDuration(c.caps.maxWallTimeMs)} · ${tokenCap} · ${cost}` },
    { label: 'Verify', value: c.completion.verifyCommand || (loop.manualReviewOnly ? 'manual review (no command)' : 'auto-detected') },
    { label: 'Options', value: flags.length ? flags.join(', ') : 'defaults' },
  ];
}
