import {
  coercePendingInput,
  type LoopConfig,
  type LoopPendingInput,
  type LoopStage,
} from '../../shared/types/loop.types';
import { LOOP_TEXT_FILE_MAX_BYTES, readUtf8FileHeadSync } from './bounded-file-read';
import { parseTaskLedger, type LoopTaskItem, type LoopTaskLedger } from './loop-task-ledger';

export type PendingInputLike = string | LoopPendingInput;

export interface LoopCapUsageSnapshot {
  totalTokens: number;
  totalCostCents: number;
}

export function renderPendingInput(input: PendingInputLike, index: number): string {
  const item = coercePendingInput(input);
  return `${index + 1}. [${item.kind}/${item.source}] ${item.message}`;
}

export function renderCapsRemaining(
  config: LoopConfig,
  iterationSeq: number,
  capUsage?: LoopCapUsageSnapshot,
): string {
  const iterationRemaining = config.caps.maxIterations === null
    ? 'unbounded iterations'
    : `${Math.max(0, config.caps.maxIterations - iterationSeq)} iteration(s)`;
  const tokenCap = renderRemainingCap('token', config.caps.maxTokens, capUsage?.totalTokens);
  const costCap = renderRemainingCap('cent', config.caps.maxCostCents, capUsage?.totalCostCents);
  return `${iterationRemaining}; ${tokenCap}; ${costCap}`;
}

export function renderSystemReminder(options: {
  config: LoopConfig;
  iterationSeq: number;
  currentStage: LoopStage;
  stagePath: string;
  tasksPath: string;
  blockedPath: string;
  capUsage?: LoopCapUsageSnapshot;
}): string {
  const ledger = readTaskLedgerForPrompt(options.tasksPath);
  const blockedText = readBlockedForPrompt(options.blockedPath);
  return `\n\n## System Reminder\n` +
    `- Current stage: ${options.currentStage} (read \`${options.stagePath}\`; it is the source of truth).\n` +
    `- Caps remaining: ${renderCapsRemaining(options.config, options.iterationSeq, options.capUsage)}.\n` +
    `${renderLedgerReminder(ledger, options.iterationSeq, options.tasksPath)}\n` +
    `${renderBlockStatus(options.blockedPath, blockedText)}\n`;
}

export function renderLedgerReminder(ledger: LoopTaskLedger, iterationSeq: number, tasksPath: string): string {
  const lines = [
    `- Ledger anchor: \`${tasksPath}\`. Keep exactly one \`[~]\` doing item when work is active; all terminal items must be \`[x]\` or \`[-]\` with a reason.`,
  ];
  if (ledger.total === 0) {
    lines.push('- Ledger status: no checkbox items yet; seed the ledger before trying to stop.');
    return lines.join('\n');
  }
  const doingCount = ledger.items.filter((item) => item.state === 'doing').length;
  const next = ledger.nextTodo ? `next: ${ledger.nextTodo}` : 'next: none';
  lines.push(`- Ledger status: ${ledger.resolved}/${ledger.total} resolved; ${next}; doing: ${doingCount}.`);
  const openItems = ledger.items.filter((item) => item.state === 'todo' || item.state === 'doing');
  if (iterationSeq > 0 && iterationSeq % 10 === 0 && openItems.length > 0) {
    lines.push('- Open ledger items:');
    for (const item of openItems.slice(0, 8)) lines.push(`  - ${renderLedgerItem(item)}`);
    if (openItems.length > 8) lines.push(`  - ... ${openItems.length - 8} more`);
  }
  return lines.join('\n');
}

export function renderBlockStatus(blockedPath: string, blockedText: string | null): string {
  if (blockedText === null) return `- Block status: \`${blockedPath}\` is not present.`;
  const excerpt = blockedText.replace(/\s+/g, ' ').trim().slice(0, 200);
  return excerpt
    ? `- Block status: \`${blockedPath}\` exists: ${excerpt}`
    : `- Block status: \`${blockedPath}\` exists.`;
}

function renderLedgerItem(item: LoopTaskItem): string {
  const marker = item.state === 'doing' ? '~' : ' ';
  return `[${marker}] ${item.text}`;
}

function readTaskLedgerForPrompt(tasksPath: string): LoopTaskLedger {
  try {
    return parseTaskLedger(readUtf8FileHeadSync(tasksPath, LOOP_TEXT_FILE_MAX_BYTES).text);
  } catch {
    return parseTaskLedger('');
  }
}

function readBlockedForPrompt(blockedPath: string): string | null {
  try {
    return readUtf8FileHeadSync(blockedPath, 2048).text;
  } catch {
    return null;
  }
}

function renderRemainingCap(unit: string, max: number | null, used: number | undefined): string {
  if (max === null) return `unbounded ${unit}s`;
  if (typeof used !== 'number' || !Number.isFinite(used)) return `${max} ${unit} cap`;
  const normalizedUsed = Math.max(0, Math.floor(used));
  return `${Math.max(0, max - normalizedUsed)} ${unit}(s) remaining (${normalizedUsed} used of ${max})`;
}
