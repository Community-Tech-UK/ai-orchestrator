import type { LoopPreflightResult } from '../../../../shared/types/loop-audit.types';

export interface LoopAuditChipInput {
  audit?: {
    preflightMode?: 'off' | 'record' | 'block';
    finalAuditMode?: 'off' | 'observe' | 'gate';
  } | null;
  preflight?: LoopPreflightResult;
  latestFinalAudit?: {
    status: string;
    reportPath?: string;
  } | null;
}

export interface LoopAuditChipView {
  preflightState: string;
  finalAuditState: string;
  preflightLabel: string;
  finalAuditLabel: string;
  preflightTitle: string;
  finalAuditTitle: string;
  reportFile: string | null;
}

/**
 * Compact preflight / final-audit chips for the loop strip.
 *
 * A `record` preflight cannot stop the run. A timeout there means the starting
 * tree is UNKNOWN, not that tests are red — painting it as a blocking failure
 * sent operators hunting for a broken build (LT-302 wording, LT-532 residual).
 */
/** L6: short HUD wording per named non-convergence reason. */
const NON_CONVERGENCE_CHIP: Readonly<Record<string, string>> = {
  code_review_non_converging: 'review not converging',
  landable_uncommitted: 'landable · uncommitted',
  scope_expanded: 'scope widened',
  no_progress: 'no progress',
};

export function buildHonestyChips(input: {
  autoUnstick?: { attempt: number; max: number; signalId: string } | null;
  capWrapUpIntent?: { cap: string } | null;
  /** L6: the named reason the run stopped converging, when one was found. */
  nonConvergence?: { reason: string } | null;
  /** L6: ledger leaves deferred with a reason. The work is not dropped. */
  parkedLeaves?: readonly { id: string }[] | null;
} | null | undefined): string[] {
  if (!input) return [];
  const chips: string[] = [];
  if (input.autoUnstick) {
    chips.push(`unstick ${input.autoUnstick.attempt}/${input.autoUnstick.max} · ${input.autoUnstick.signalId}`);
  }
  if (input.capWrapUpIntent) {
    chips.push(`wrap-up · ${input.capWrapUpIntent.cap} cap`);
  }
  // L6: name the diagnosis on the HUD. "no progress" alone is true and useless;
  // "review not converging" tells the operator which lever to pull.
  if (input.nonConvergence) {
    chips.push(NON_CONVERGENCE_CHIP[input.nonConvergence.reason] ?? input.nonConvergence.reason);
  }
  const parked = input.parkedLeaves?.length ?? 0;
  if (parked > 0) {
    chips.push(`${parked} item${parked === 1 ? '' : 's'} parked`);
  }
  return chips;
}

export function buildLoopAuditChips(input: LoopAuditChipInput | null | undefined): LoopAuditChipView | null {
  if (!input) return null;
  const auditConfig = input.audit;
  if (!auditConfig && !input.preflight && !input.latestFinalAudit) return null;

  const preflightMode = auditConfig?.preflightMode ?? 'off';
  const finalAuditMode = auditConfig?.finalAuditMode ?? 'off';
  const preflightStatus = input.preflight?.status ?? (preflightMode === 'off' ? 'off' : 'pending');
  const finalAuditStatus = input.latestFinalAudit?.status ?? (finalAuditMode === 'off' ? 'skipped' : 'pending');
  const recordMode = preflightMode !== 'block';
  const preflightTimedOut = preflightStatus === 'failed'
    && (input.preflight?.commands?.some((command) => command.failureKind === 'timeout') ?? false);

  return {
    preflightState: recordMode && (preflightTimedOut || preflightStatus === 'skipped')
      ? 'skipped'
      : preflightStatus,
    finalAuditState: finalAuditStatus,
    preflightLabel: preflightChipLabel(preflightStatus, preflightTimedOut, recordMode),
    finalAuditLabel: finalAuditChipLabel(finalAuditMode, finalAuditStatus),
    preflightTitle: preflightChipTitle(preflightStatus, preflightTimedOut, recordMode),
    finalAuditTitle: finalAuditChipTitle(finalAuditStatus),
    reportFile: input.latestFinalAudit?.reportPath
      ? basename(input.latestFinalAudit.reportPath)
      : null,
  };
}

function preflightChipLabel(
  status: string,
  timedOut: boolean,
  recordMode: boolean,
): string {
  if (timedOut && recordMode) return 'Preflight baseline unknown';
  if (timedOut) return 'Preflight timed out';
  return `Preflight ${auditStatusLabel(status)}`;
}

function finalAuditChipLabel(mode: string, status: string): string {
  if (status === 'pending') return 'Final audit pending';
  return `Audit ${mode} ${auditStatusLabel(status)}`;
}

function preflightChipTitle(
  status: string,
  timedOut: boolean,
  recordMode: boolean,
): string {
  if (timedOut && recordMode) {
    return 'Record-only preflight hit its time budget. The starting tree is unknown, not proven red. This does not block the run.';
  }
  if (timedOut) {
    return 'Preflight is a gate and hit its time budget before the baseline command finished.';
  }
  if (recordMode && status === 'skipped') {
    return 'Record-only preflight skipped the full verify. It does not block the run. Set a quick-verify command if you want a cheap baseline.';
  }
  if (recordMode && status === 'failed') {
    return 'Record-only preflight: a recorded command failed. This does not block the run, but the tree was already red at start.';
  }
  if (status === 'pending') return 'Preflight has not finished yet.';
  if (status === 'passed') return 'Preflight baseline was green.';
  if (status === 'off') return 'Preflight is off for this run.';
  return 'Preflight status.';
}

function finalAuditChipTitle(status: string): string {
  if (status === 'pending') {
    return 'Final audit runs when the loop tries to complete. Pending means it has not run yet.';
  }
  if (status === 'needs-review') {
    return 'Final audit wants a human look before completion is accepted.';
  }
  if (status === 'failed') return 'Final audit rejected completion.';
  if (status === 'passed') return 'Final audit passed.';
  if (status === 'skipped') return 'Final audit is off or was skipped.';
  return 'Final audit status.';
}

function auditStatusLabel(status: string): string {
  return status === 'needs-review' ? 'needs review' : status;
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}
