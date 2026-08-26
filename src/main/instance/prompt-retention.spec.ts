import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import {
  PINNED_PROMPT_LIMIT,
  findOriginalRequest,
  mergeRetainedPrompts,
  promptsDiscardedByTruncation,
  retainedPromptsForFork,
  retainedPromptsMissingFrom,
} from './prompt-retention';

function message(id: string, type: OutputMessage['type'], content = id): OutputMessage {
  return { id, type, content, timestamp: 1_000 } as OutputMessage;
}

function prompts(count: number, prefix = 'p'): OutputMessage[] {
  return Array.from({ length: count }, (_, index) => message(`${prefix}${index}`, 'user'));
}

describe('mergeRetainedPrompts', () => {
  it('returns the existing set untouched when the overflow held no prompts', () => {
    const existing = prompts(2);

    expect(mergeRetainedPrompts(existing, [message('a', 'assistant')])).toBe(existing);
  });

  it('collects prompts out of a mixed overflow slice, in order', () => {
    const overflow = [
      message('p0', 'user'),
      message('a', 'assistant'),
      message('p1', 'user'),
      message('t', 'tool_result'),
    ];

    expect(mergeRetainedPrompts(undefined, overflow).map((m) => m.id)).toEqual(['p0', 'p1']);
  });

  it('accumulates across successive trims', () => {
    const first = mergeRetainedPrompts(undefined, [message('p0', 'user')]);
    const second = mergeRetainedPrompts(first, [message('p1', 'user')]);

    expect(second.map((m) => m.id)).toEqual(['p0', 'p1']);
  });

  it('ignores a prompt it already retained', () => {
    const first = mergeRetainedPrompts(undefined, [message('p0', 'user')]);
    const second = mergeRetainedPrompts(first, [message('p0', 'user')]);

    expect(second.map((m) => m.id)).toEqual(['p0']);
  });

  it('treats the same prompt under a new id as already retained', () => {
    // Persisted history renumbers ids positionally on every checkpoint, so the
    // same prompt returns from a wake wearing a different id.
    const first = mergeRetainedPrompts(undefined, [
      { ...message('p0', 'user', 'Opening ask.'), timestamp: 1 } as OutputMessage,
    ]);
    const renamed = { ...message('restored-prompt-msg-0', 'user', 'Opening ask.'), timestamp: 1 };

    expect(mergeRetainedPrompts(first, [renamed as OutputMessage])).toHaveLength(1);
  });

  it('still distinguishes prompts that merely repeat the same text later', () => {
    const first = mergeRetainedPrompts(undefined, [
      { ...message('p0', 'user', 'retry'), timestamp: 1 } as OutputMessage,
    ]);
    const laterRepeat = { ...message('p9', 'user', 'retry'), timestamp: 900 };

    expect(mergeRetainedPrompts(first, [laterRepeat as OutputMessage])).toHaveLength(2);
  });

  it('keeps the retained set in chronological order', () => {
    const later = { ...message('p9', 'user', 'later'), timestamp: 900 } as OutputMessage;
    const earlier = { ...message('p0', 'user', 'earlier'), timestamp: 1 } as OutputMessage;

    const merged = mergeRetainedPrompts([later], [earlier]);

    expect(merged.map((m) => m.content)).toEqual(['earlier', 'later']);
  });

  it('always keeps the opening prompt once over the limit', () => {
    const merged = mergeRetainedPrompts(undefined, prompts(PINNED_PROMPT_LIMIT + 25));

    expect(merged).toHaveLength(PINNED_PROMPT_LIMIT);
    expect(merged[0].id).toBe('p0');
    // The remainder is the newest tail, so the dropped ones are the middle.
    expect(merged[merged.length - 1].id).toBe(`p${PINNED_PROMPT_LIMIT + 24}`);
  });

  it('stays bounded across many successive trims', () => {
    let retained: OutputMessage[] | undefined;
    for (let trim = 0; trim < 200; trim++) {
      retained = mergeRetainedPrompts(retained, [message(`p${trim}`, 'user')]);
    }

    expect(retained).toHaveLength(PINNED_PROMPT_LIMIT);
    expect(retained?.[0].id).toBe('p0');
    expect(retained?.[retained.length - 1].id).toBe('p199');
  });

  it('does not mutate the array it was given', () => {
    const existing = prompts(2);

    mergeRetainedPrompts(existing, [message('p9', 'user')]);

    expect(existing).toHaveLength(2);
  });
});

describe('retainedPromptsMissingFrom', () => {
  it('returns nothing when there are no retained prompts', () => {
    expect(retainedPromptsMissingFrom(undefined, [message('a', 'assistant')])).toEqual([]);
  });

  it('drops prompts the live window already covers', () => {
    const retained = prompts(3);

    const missing = retainedPromptsMissingFrom(retained, [retained[2], message('a', 'assistant')]);

    expect(missing.map((m) => m.id)).toEqual(['p0', 'p1']);
  });
});

describe('findOriginalRequest', () => {
  it('prefers the oldest retained prompt over the live buffer', () => {
    const found = findOriginalRequest(
      [message('p0', 'user', 'the original ask')],
      [message('p9', 'user', 'a later ask')],
    );

    expect(found?.content).toBe('the original ask');
  });

  it('falls back to the oldest prompt still in the buffer', () => {
    const found = findOriginalRequest(undefined, [
      message('a', 'assistant'),
      message('p9', 'user', 'only ask on record'),
    ]);

    expect(found?.content).toBe('only ask on record');
  });

  it('returns undefined when no prompt is known', () => {
    expect(findOriginalRequest(undefined, [message('a', 'assistant')])).toBeUndefined();
  });
});

describe('retainedPromptsForFork', () => {
  const opening = { ...message('p0', 'user', 'Migrate the billing service.'), timestamp: 1 };

  it('inherits prompts older than the excluded boundary', () => {
    const boundary = { ...message('m5', 'assistant'), timestamp: 5 };

    expect(retainedPromptsForFork([opening], [], boundary).map((m) => m.id)).toEqual(['p0']);
  });

  it('inherits when forking at index 0, where the forked slice is empty', () => {
    // "Edit the oldest message I can still see" after compaction shrank the
    // buffer — the opening prompt still predates it and must survive.
    const oldestVisible = { ...message('m5', 'user', 'oldest visible'), timestamp: 5 };

    const inherited = retainedPromptsForFork([opening], [], oldestVisible);

    expect(inherited.map((m) => m.id)).toEqual(['p0']);
  });

  it('drops prompts newer than the boundary', () => {
    const later = { ...message('p9', 'user', 'a later ask'), timestamp: 99 };
    const boundary = { ...message('m5', 'assistant'), timestamp: 5 };

    expect(retainedPromptsForFork([later], [], boundary)).toEqual([]);
  });

  it('never carries the boundary message itself, which edit-and-resend replaces', () => {
    expect(retainedPromptsForFork([opening], [], opening)).toEqual([]);
  });

  it('still inherits prehistory older than the boundary when the slice is empty', () => {
    // A cut at index 0 keeps nothing of the visible transcript, but prompts
    // that predate the cut point are still this branch's prehistory.
    const older = { ...message('p-older', 'user', 'Even earlier ask.'), timestamp: 1 };
    const boundary = { ...message('p0', 'user', 'Cut point.'), timestamp: 5 };

    expect(retainedPromptsForFork([older, boundary], [], boundary).map((m) => m.id))
      .toEqual(['p-older']);
  });

  it('inherits everything when the fork excluded nothing', () => {
    expect(retainedPromptsForFork([opening], [], undefined).map((m) => m.id)).toEqual(['p0']);
  });

  it('drops prompts the forked slice already contains', () => {
    const boundary = { ...message('m5', 'assistant'), timestamp: 5 };

    expect(retainedPromptsForFork([opening], [opening], boundary)).toEqual([]);
  });
});

describe('promptsDiscardedByTruncation', () => {
  const entry = (id: string, role: string, timestamp: number) =>
    ({ id, role, content: `${id} content`, timestamp });

  it('returns the prompts a keep-newest-N truncation would drop', () => {
    const history = [
      entry('msg-0', 'user', 1),
      entry('msg-1', 'assistant', 2),
      entry('msg-2', 'user', 3),
      entry('msg-3', 'assistant', 4),
    ];

    const dropped = promptsDiscardedByTruncation(history, 2, 'restored-prompt-');

    expect(dropped.map((m) => m.id)).toEqual(['restored-prompt-msg-0']);
    expect(dropped[0].type).toBe('user');
    expect(dropped[0].content).toBe('msg-0 content');
  });

  it('returns nothing when the history fits inside the kept window', () => {
    expect(promptsDiscardedByTruncation([entry('msg-0', 'user', 1)], 50, 'p-')).toEqual([]);
  });

  it('derives stable ids so repeated wakes do not accumulate duplicates', () => {
    const history = [entry('msg-0', 'user', 1), entry('msg-1', 'assistant', 2)];

    const first = promptsDiscardedByTruncation(history, 1, 'restored-prompt-');
    const second = promptsDiscardedByTruncation(history, 1, 'restored-prompt-');

    expect(mergeRetainedPrompts(first, second)).toHaveLength(1);
  });

  it('ignores non-user roles', () => {
    const history = [entry('msg-0', 'tool', 1), entry('msg-1', 'assistant', 2), entry('msg-2', 'user', 3)];

    expect(promptsDiscardedByTruncation(history, 0, 'p-').map((m) => m.id)).toEqual(['p-msg-2']);
  });
});
