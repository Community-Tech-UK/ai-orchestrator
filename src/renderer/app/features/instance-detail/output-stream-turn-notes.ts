/**
 * Turn notes for the output stream.
 *
 * Reads the raw transcript, works out each turn (turn-projection.ts), and says
 * which row of the transcript each turn's note belongs under: the last row of
 * that turn that is actually shown. A note therefore still appears when tool
 * groups are hidden, and never lands in the middle of a work cycle.
 *
 * It also asks the main process which files changed while each finished turn
 * ran (a snapshot of the folder before and after, see TurnFileBaselineService).
 * A steered turn is measured in one span per input, so its spans are chained
 * and their files counted together. The count is shown only when it can be
 * trusted:
 *  - the "before" snapshot finished before the turn's first tool call, so it
 *    cannot already contain the agent's own first edit;
 *  - the "after" snapshot finished after the turn's last piece of work;
 *  - and every span in between meets its neighbour, so nothing is unmeasured.
 * An answer that is unavailable, late or failed means no count, never a guess.
 */

import { computed, effect, inject, signal, type Signal } from '@angular/core';
import type { EditFailureWarning, TurnSummary } from '../../../../shared/summarise-turn';
import type { TurnBaselineResult } from '../../../../shared/types/turn-file-changes.types';
import { TurnBaselineIpcService } from '../../core/services/ipc/turn-baseline-ipc.service';
import { InstanceStore } from '../../core/state/instance/instance.store';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import type { DisplayItem } from './display-item.types';
import { projectTurns, type TurnProjection } from './turn-projection';

export interface TurnNote {
  turnKey: string;
  summary: TurnSummary | null;
  warning: EditFailureWarning | null;
  /** Files that changed while the turn ran; 0 hides the button. */
  changedFiles: number;
  changedPaths: readonly string[];
}

export interface TurnNotesHost {
  messages: () => readonly OutputMessage[];
  /** The rows being shown, in order, after hiding and merging. */
  items: () => readonly DisplayItem[];
  instanceId: () => string;
}

/** Statuses in which the instance is still working on a turn. */
const WORKING_STATUSES: ReadonlySet<string> = new Set([
  'initializing', 'busy', 'processing', 'thinking_deeply', 'waiting_for_permission',
  'interrupting', 'cancelling', 'interrupt-escalating', 'respawning', 'waking',
]);

/** Most answers held at once; the oldest go first. */
const MAX_REMEMBERED = 400;

const NO_NOTES: ReadonlyMap<string, TurnNote> = new Map();

export class OutputStreamTurnNotes {
  private readonly store = inject(InstanceStore);
  private readonly baselines = inject(TurnBaselineIpcService);

  /** Main-process answers, by session and turn so one session's answer is never shown for another. */
  private readonly answers = signal<ReadonlyMap<string, TurnBaselineResult | null>>(new Map());
  /** Where each turn had got to when it was last asked about. */
  private readonly asked = new Map<string, number>();

  private readonly instance = computed(() => this.store.getInstance(this.host.instanceId()));

  readonly projection = computed(() => {
    const instance = this.instance();
    return projectTurns(this.host.messages(), {
      cwd: instance?.workingDirectory,
      lastTurnOpen: instance ? WORKING_STATUSES.has(instance.status) : undefined,
      lastTurnOutcome: instance?.lastTurnOutcome,
    });
  });

  /** Notes by the id of the row they sit under. */
  readonly notes: Signal<ReadonlyMap<string, TurnNote>> = computed(() => {
    const { turns, turnOfMessage } = this.projection();
    if (turns.length === 0) return NO_NOTES;

    const instanceId = this.host.instanceId();
    const answers = this.answers();
    const lastRowOfTurn = new Map<number, string>();
    let carried: number | undefined;
    for (const item of this.host.items()) {
      const messageId = lastMessageIdOf(item);
      const turn = (messageId === undefined ? undefined : turnOfMessage.get(messageId)) ?? carried;
      if (turn === undefined) continue;
      carried = turn;
      lastRowOfTurn.set(turn, item.id);
    }

    const notes = new Map<string, TurnNote>();
    for (const [turnIndex, rowId] of lastRowOfTurn) {
      const turn = turns[turnIndex];
      const changed = trustedChanges(turn, turn.inputKeys.map((turnKey) => answers.get(answerKey(instanceId, turnKey))));
      if (!turn.summary && !turn.warning && changed.total === 0) continue;
      notes.set(rowId, {
        turnKey: turn.key,
        summary: turn.summary,
        warning: turn.warning,
        changedFiles: changed.total,
        changedPaths: changed.paths,
      });
    }
    return notes;
  });

  constructor(private readonly host: TurnNotesHost) {
    effect(() => {
      const instance = this.instance();
      // Only a live local session has a folder to compare. A chat, a history
      // preview and a remote computer get no count.
      if (!instance || instance.executionLocation?.type === 'remote') return;
      const instanceId = this.host.instanceId();
      for (const turn of this.projection().turns) {
        if (!wantsComparison(turn)) continue;
        for (const turnKey of turn.inputKeys) {
          const key = answerKey(instanceId, turnKey);
          if ((this.asked.get(key) ?? -1) >= turn.activityEndedAt) continue;
          remember(this.asked, key, turn.activityEndedAt);
          void this.ask(instanceId, turnKey, key);
        }
      }
    });
  }

  noteFor(rowId: string): TurnNote | undefined {
    return this.notes().get(rowId);
  }

  private async ask(instanceId: string, turnKey: string, key: string): Promise<void> {
    let result: TurnBaselineResult | null;
    try {
      result = await this.baselines.getTurnFileChanges(instanceId, turnKey);
    } catch {
      result = null;
    }
    const next = new Map(this.answers());
    remember(next, key, result);
    this.answers.set(next);
  }
}

// ---------------------------------------------------------------------------

function answerKey(instanceId: string, turnKey: string): string {
  return `${instanceId}\u0000${turnKey}`;
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_REMEMBERED) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** A finished turn that used tools can have changed files; one that did not cannot. */
function wantsComparison(turn: TurnProjection): boolean {
  return turn.complete && turn.settled && turn.toolEvents.length > 0
    && (turn.startKind === 'user' || turn.startKind === 'machine');
}

function trustedChanges(
  turn: TurnProjection,
  parts: readonly (TurnBaselineResult | null | undefined)[],
): { total: number; paths: string[] } {
  const none = { total: 0, paths: [] };
  const answers: Extract<TurnBaselineResult, { state: 'ready' }>[] = [];
  for (const part of parts) {
    // An answer that is unavailable, late or failed means no count, never a guess.
    if (part?.state !== 'ready') return none;
    answers.push(part);
  }
  if (answers.length === 0) return none;
  const first = answers[0]!;
  const last = answers[answers.length - 1]!;
  // A snapshot that finished after the first tool call could already hold the
  // agent's own edit, and one that finished before the turn did missed its end.
  if (turn.firstToolAt !== undefined && first.baselineCompletedAt > turn.firstToolAt) return none;
  if (last.endedAt < turn.activityEndedAt) return none;
  // A steered turn is measured in one span per input; each span ends where the
  // next begins. A gap means part of the turn went unmeasured.
  for (let at = 1; at < answers.length; at += 1) {
    if (answers[at - 1]!.endedAt < answers[at]!.baselineCompletedAt) return none;
  }
  const paths = [...new Set(answers.flatMap((answer) => answer.files.map((file) => file.path)))];
  // A single span keeps its exact total even when its path list was truncated
  // for display; the row shows the real count. A steered turn is summed by
  // exact paths, so a truncated span leaves the union unmeasurable.
  if (answers.length === 1) return { total: first.total, paths };
  if (answers.some((answer) => answer.truncated)) return none;
  return { total: paths.length, paths };
}

/** Id of the last transcript message that went into this row, if it carries one. */
function lastMessageIdOf(item: DisplayItem): string | undefined {
  switch (item.type) {
    case 'work-cycle': {
      const last = item.children?.[item.children.length - 1];
      return last ? lastMessageIdOf(last) : undefined;
    }
    case 'tool-group':
      return item.toolMessages?.[item.toolMessages.length - 1]?.id;
    case 'system-event-group':
      return item.systemEvents?.[item.systemEvents.length - 1]?.id;
    case 'thought-group':
      return item.response?.id ?? (item.id.startsWith('thought-') ? item.id.slice('thought-'.length) : undefined);
    default:
      return item.message?.id;
  }
}
