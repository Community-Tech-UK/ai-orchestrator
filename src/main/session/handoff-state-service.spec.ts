import { beforeEach, describe, expect, it } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import {
  buildHandoffDocumentFromMessages,
  HandoffStateService,
} from './handoff-state-service';

function message(id: string, type: 'user' | 'assistant' | 'system', content: string): OutputMessage {
  return { id, type, content, timestamp: Number(id.replace(/\D/g, '') || 1) } as OutputMessage;
}

function makeInstance(outputBuffer: OutputMessage[]): Pick<
  Instance,
  'id' | 'outputBuffer' | 'workingDirectory' | 'provider' | 'currentModel'
> {
  return {
    id: 'inst-1',
    outputBuffer,
    workingDirectory: '/repo',
    provider: 'claude',
    currentModel: 'sonnet',
  } as Pick<Instance, 'id' | 'outputBuffer' | 'workingDirectory' | 'provider' | 'currentModel'>;
}

function turnPair(index: number, extra = ''): OutputMessage[] {
  return [
    message(`u${index}`, 'user', `user turn ${index} ${extra}`),
    message(`a${index}`, 'assistant', `assistant reply ${index}: implement the widget ${extra}`),
  ];
}

describe('HandoffStateService', () => {
  let service: HandoffStateService;

  beforeEach(() => {
    HandoffStateService._resetForTesting();
    service = HandoffStateService.getInstance();
  });

  it('returns null before any turns were maintained (caller falls through)', () => {
    expect(service.buildHandoffDocument(makeInstance([]), 'provider-change')).toBeNull();
  });

  it('ingests each conversational message once, even when the buffer is re-scanned', () => {
    const buffer = [...turnPair(1), message('s1', 'system', 'noise')];
    const instance = makeInstance(buffer);
    service.noteTurnCompleted(instance);
    service.noteTurnCompleted(instance); // same buffer again — no double count

    const doc = service.buildHandoffDocument(instance, 'provider-change')!;
    expect(doc).toContain('Human: user turn 1');
    expect((doc.match(/Human: user turn 1/g) ?? []).length).toBe(1);
    expect(doc).not.toContain('noise'); // system messages are not turns
  });

  it('folds overflow into an anchored rolling summary and keeps recent turns verbatim', () => {
    const buffer: OutputMessage[] = [];
    const instance = makeInstance(buffer);
    for (let i = 1; i <= 20; i++) {
      buffer.push(...turnPair(i));
      service.noteTurnCompleted(instance);
    }

    const doc = service.buildHandoffDocument(instance, 'provider-change')!;
    // 40 conversational messages, ring keeps 24 → 16 folded.
    expect(doc).toContain('Rolling summary (16 earlier turns folded):');
    // Early turns live in the summary, not the transcript section.
    expect(doc).not.toContain('Human: user turn 1 ');
    // Recent turns stay verbatim.
    expect(doc).toContain('Human: user turn 20');
    // Summary carries the local-summary shape.
    expect(doc).toContain('## Objective');
  });

  it('anchors prior summaries across successive folds so early decisions survive', () => {
    const buffer: OutputMessage[] = [];
    const instance = makeInstance(buffer);
    for (let i = 1; i <= 40; i++) {
      buffer.push(...turnPair(i));
      service.noteTurnCompleted(instance);
    }
    const doc = service.buildHandoffDocument(instance, 'provider-change')!;
    expect(doc).toContain('Anchored from prior compaction');
  });

  it('surfaces unresolved checklist items and workspace facts, and redacts secrets', () => {
    const buffer = [
      ...turnPair(1),
      message('a99', 'assistant', '- [ ] wire the panel\nAPI key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789012345678901234567'),
    ];
    const instance = makeInstance(buffer);
    service.noteTurnCompleted(instance);

    const doc = service.buildHandoffDocument(instance, 'provider-change')!;
    expect(doc).toContain('- wire the panel');
    expect(doc).toContain('Working directory: /repo');
    expect(doc).toContain('Runtime: claude (sonnet)');
    expect(doc).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  });

  it('drops state on removal and bounds tracked instances', () => {
    const instance = makeInstance([...turnPair(1)]);
    service.noteTurnCompleted(instance);
    service.removeInstance('inst-1');
    expect(service.buildHandoffDocument(instance, 'provider-change')).toBeNull();
  });
});

describe('buildHandoffDocumentFromMessages', () => {
  it('renders the same document shape from an archived transcript', () => {
    const messages: OutputMessage[] = [];
    for (let i = 1; i <= 20; i++) messages.push(...turnPair(i));

    const doc = buildHandoffDocumentFromMessages(messages, {
      reason: 'history-restore-replay',
      workingDirectory: '/repo',
      provider: 'codex',
      model: 'gpt-5.5',
    })!;

    expect(doc).toContain('maintained handoff document (history-restore-replay)');
    expect(doc).toContain('Rolling summary (16 earlier turns folded):');
    expect(doc).toContain('Human: user turn 20');
    expect(doc).toContain('Runtime: codex (gpt-5.5)');
    expect(doc).toContain('</conversation_history>');
  });

  it('returns null for a transcript with no conversational turns', () => {
    expect(
      buildHandoffDocumentFromMessages([message('s1', 'system', 'only system')], { reason: 'x' }),
    ).toBeNull();
  });
});
