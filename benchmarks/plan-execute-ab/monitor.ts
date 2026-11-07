/**
 * Arm F takeover monitor: "Opus takes over after 2 failed test runs or 15
 * turns with no progress". Progress means a file edit; a failed test run is a
 * Bash tool call that ran tests and returned an error.
 *
 * A "turn" is one assistant MESSAGE, matching the unit `--max-turns` /
 * `num_turns` count: Claude's stream-json emits one event per content block,
 * all sharing `message.id`, so counting events would fire a "15 turns with no
 * progress" takeover after only five real turns and spend the rest of the
 * budget on Opus. Events without a message id (legacy fixtures) count as turns.
 */

/** Raw stream-json events; fields are read defensively. */
export type MonitorEvent = Record<string, unknown>;

export interface TakeoverDecision {
  abort: boolean;
  reason: string;
}

export interface TakeoverMonitor {
  onEvent(event: MonitorEvent): TakeoverDecision;
  snapshot(): { failedTestRunsSinceEdit: number; turnsSinceEdit: number };
}

const TEST_COMMAND_PATTERN = /\b(test|vitest|jest|pytest|phpunit|gradle|maven|npm run test|pnpm test)\b/i;
const EDIT_TOOL_PATTERN = /^(Edit|Write|NotebookEdit|MultiEdit)$/;

/**
 * Real Claude stream-json edits are `{ type: 'tool_use', name: 'Edit' | 'Write'
 * | ... }` — the tool name lives on `name`. The flat `{ type: 'Edit' }` shape is
 * still accepted so older fixtures work, but matching `type` alone against the
 * edit-tool names misses every real edit and fires takeover mid-progress.
 */
function isEditToolBlock(block: Record<string, unknown>): boolean {
  const blockType = block['type'];
  if (blockType === 'tool_use') {
    const name = block['name'];
    return typeof name === 'string' && EDIT_TOOL_PATTERN.test(name);
  }
  return typeof blockType === 'string' && EDIT_TOOL_PATTERN.test(blockType);
}

export function createTakeoverMonitor(options: { maxFailedTestRuns: number; maxTurnsWithoutProgress: number }): TakeoverMonitor {
  let failedTestRunsSinceEdit = 0;
  let turnsSinceEdit = 0;
  // Message ids already counted as turns (not cleared on edit: later blocks of
  // the editing message belong to the same turn that just registered progress).
  const countedMessageIds = new Set<string>();
  // One entry per in-flight test Bash call, keyed by its tool_use id so results
  // in the same message (Bash('npm test') batched with Bash('ls')) are matched
  // to the right call. Legacy fixtures without ids get synthetic keys and their
  // results are matched in call order.
  const pendingTestCommands: string[] = [];
  let nextSyntheticId = 0;

  return {
    onEvent(event: MonitorEvent): TakeoverDecision {
      const type = event['type'];
      if (type === 'assistant') {
        const message = event['message'] as { id?: unknown; content?: Record<string, unknown>[] } | undefined;
        const messageId = typeof message?.id === 'string' ? message.id : undefined;
        if (messageId === undefined) {
          turnsSinceEdit += 1;
        } else if (!countedMessageIds.has(messageId)) {
          countedMessageIds.add(messageId);
          turnsSinceEdit += 1;
        }
        for (const block of message?.content ?? []) {
          if (isEditToolBlock(block)) {
            failedTestRunsSinceEdit = 0;
            turnsSinceEdit = 0;
          }
          if (block['type'] === 'tool_use' && block['name'] === 'Bash') {
            const input = block['input'] as { command?: unknown } | undefined;
            const command = typeof input?.command === 'string' ? input.command : '';
            if (TEST_COMMAND_PATTERN.test(command)) {
              const id = typeof block['id'] === 'string' ? block['id'] : `__no_id_${nextSyntheticId}`;
              if (typeof block['id'] !== 'string') nextSyntheticId += 1;
              pendingTestCommands.push(id);
            }
          }
        }
      } else if (type === 'user') {
        const message = event['message'] as { content?: Record<string, unknown>[] } | undefined;
        for (const block of message?.content ?? []) {
          if (block['type'] !== 'tool_result') continue;
          const resultId = block['tool_use_id'];
          let index = -1;
          if (typeof resultId === 'string') {
            index = pendingTestCommands.indexOf(resultId);
          } else if (pendingTestCommands.length > 0) {
            index = 0;
          }
          if (index === -1) continue;
          pendingTestCommands.splice(index, 1);
          if (block['is_error'] === true) {
            failedTestRunsSinceEdit += 1;
          }
        }
      }

      if (failedTestRunsSinceEdit >= options.maxFailedTestRuns) {
        return {
          abort: true,
          reason: `${failedTestRunsSinceEdit} failed test runs since the last edit (limit ${options.maxFailedTestRuns})`,
        };
      }
      if (turnsSinceEdit >= options.maxTurnsWithoutProgress) {
        return {
          abort: true,
          reason: `${turnsSinceEdit} turns with no edit (limit ${options.maxTurnsWithoutProgress})`,
        };
      }
      return { abort: false, reason: '' };
    },
    snapshot: () => ({ failedTestRunsSinceEdit, turnsSinceEdit }),
  };
}
