import { NgZone } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcFacadeService } from '../../services/ipc';
import { ProviderStateService } from '../../services/provider-state.service';
import { ImageAttachmentService } from '../../../features/instance-detail/image-attachment.service';
import { LIMITS } from '../../../../../shared/constants/limits';
import { resolveEffectiveInstanceTitle } from '../../../../../shared/types/history.types';
import { PINNED_PROMPT_LIMIT, trimBufferRetainingPrompts } from '../../../../../shared/utils/prompt-retention';
import { InstanceListStore } from './instance-list.store';
import { InstanceOutputStore } from './instance-output.store';
import { InstanceStateService } from './instance-state.service';
import type { OutputMessage } from './instance.types';

const opener: OutputMessage = {
  id: 'opening', timestamp: 1, type: 'user', content: 'Work Finder watchdog faults',
};
const followup: OutputMessage = {
  id: 'followup', timestamp: 100000, type: 'user', content: 'OAuth2 HTTP 500 followup',
};

function traffic(): OutputMessage[] {
  return Array.from({ length: LIMITS.OUTPUT_BUFFER_MAX_SIZE - 1 }, (_, i) => ({
    id: `tool-${i}`, timestamp: i + 2, type: 'tool_result', content: 'Tool result',
  }));
}

function raw(outputBuffer: OutputMessage[], extra: object = {}) {
  return {
    id: 'title-instance', displayName: '1.', createdAt: 0, parentId: null,
    childrenIds: [], status: 'idle', lastActivity: 0,
    workingDirectory: '/tmp/title-retention', outputBuffer, ...extra,
  };
}

describe('session title recovery across real renderer buffering', () => {
  let list: InstanceListStore;
  let output: InstanceOutputStore;
  let state: InstanceStateService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        InstanceListStore, InstanceOutputStore, InstanceStateService,
        { provide: IpcFacadeService, useValue: {} },
        { provide: ProviderStateService, useValue: {} },
        { provide: ImageAttachmentService, useValue: { processMessage: vi.fn() } },
        { provide: NgZone, useValue: { run: (fn: () => void) => fn() } },
      ],
    });
    list = TestBed.inject(InstanceListStore);
    output = TestBed.inject(InstanceOutputStore);
    state = TestBed.inject(InstanceStateService);
  });

  afterEach(() => {
    output.cleanupAll();
    TestBed.resetTestingModule();
  });

  it('uses the retained opener after real buffer eviction', () => {
    const instance = {
      displayName: '1.', outputBuffer: [opener, followup],
      retainedPrompts: undefined as OutputMessage[] | undefined,
    };
    expect(trimBufferRetainingPrompts(instance, 1)).toBe(1);
    expect(resolveEffectiveInstanceTitle(instance)).toBe(opener.content);
  });

  it('carries the retained opener through the actual IPC mapper', () => {
    list.addInstance(raw([followup], { retainedPrompts: [opener] }));
    expect(resolveEffectiveInstanceTitle(state.getInstance('title-instance')!)).toBe(opener.content);
  });

  it('retains the opener on the actual renderer streaming trim without shifting buffer indices', () => {
    list.addInstance(raw([opener, ...traffic()]));
    output.queueOutput('title-instance', followup);
    output.flushInstanceOutput('title-instance');
    const instance = state.getInstance('title-instance')!;
    expect(instance.outputBuffer).toHaveLength(LIMITS.OUTPUT_BUFFER_MAX_SIZE);
    expect(instance.outputBuffer[0].id).toBe('tool-0');
    expect(instance.retainedPrompts).toEqual([opener]);
    expect(resolveEffectiveInstanceTitle(instance)).toBe(opener.content);
  });

  it('retains a loaded opener when loaded history is released', () => {
    list.addInstance(raw([...traffic(), followup]));
    output.prependOlderMessages('title-instance', [opener]);
    expect(output.releaseLoadedHistory('title-instance')).toBe(1);
    expect(resolveEffectiveInstanceTitle(state.getInstance('title-instance')!)).toBe(opener.content);
  });

  it.each([
    ['stream', 'internal'], ['stream', 'cross'], ['release', 'internal'], ['release', 'cross'],
  ] as const)('pins the genuine opener through %s after older %s input and repeated follow-ups', (route, kind) => {
    const earlier: OutputMessage = { ...opener, id: 'earlier', timestamp: 0, content: 'Injected input',
      metadata: kind === 'internal'
        ? { internalInput: { actor: 'harness', source: 'context-policy' } }
        : { crossSessionMessage: { sourceInstanceId: 'source', sourceDisplayName: 'Source', hopCount: 1 } } };
    const later = Array.from({ length: 30 }, (_, index) => ({ ...followup, id: `later-${index}`, timestamp: index + 2 }));
    const overflow = [earlier, opener, ...later];
    if (route === 'stream') {
      list.addInstance(raw([...overflow, ...traffic()]));
      output.queueOutput('title-instance', followup);
      output.flushInstanceOutput('title-instance');
    } else {
      list.addInstance(raw([...traffic(), followup]));
      output.prependOlderMessages('title-instance', overflow);
      expect(output.releaseLoadedHistory('title-instance')).toBe(overflow.length);
    }
    const instance = state.getInstance('title-instance')!;
    expect(instance.outputBuffer).toHaveLength(LIMITS.OUTPUT_BUFFER_MAX_SIZE);
    expect(instance.retainedPrompts).toHaveLength(PINNED_PROMPT_LIMIT);
    expect(instance.retainedPrompts?.[0]).toEqual(opener);
    expect(resolveEffectiveInstanceTitle(instance)).toBe(opener.content);
  });

  it('pins a generic genuine opener over later meaningful follow-ups after an older injection', () => {
    const earlier: OutputMessage = { ...opener, id: 'earlier', timestamp: 0,
      metadata: { internalInput: { actor: 'harness', source: 'context-policy' } } };
    const generic = { ...opener, content: 'please continue' };
    const later = Array.from({ length: 30 }, (_, index) => ({ ...followup, id: `later-${index}`, timestamp: index + 2 }));
    list.addInstance(raw([earlier, generic, ...later, ...traffic()]));
    output.queueOutput('title-instance', followup);
    output.flushInstanceOutput('title-instance');
    const instance = state.getInstance('title-instance')!;
    expect(instance.retainedPrompts?.[0]).toEqual(generic);
    expect(resolveEffectiveInstanceTitle(instance)).toBe('Untitled thread');
  });

  it.each(['1.', 'Done', '**Question 5**'])('preserves manual %s through actual mapping', displayName => {
    list.addInstance(raw([followup], { displayName, isRenamed: true, retainedPrompts: [opener] }));
    expect(resolveEffectiveInstanceTitle(state.getInstance('title-instance')!)).toBe(displayName);
  });

  it('does not use a later task when the retained genuine opener is generic', () => {
    list.addInstance(raw([followup], { retainedPrompts: [{ ...opener, content: 'please continue' }] }));
    expect(resolveEffectiveInstanceTitle(state.getInstance('title-instance')!)).toBe('Untitled thread');
  });

  it('excludes retained internal and cross-session input before choosing the genuine opener', () => {
    const retainedPrompts: OutputMessage[] = [
      { ...opener, id: 'internal', timestamp: -2, content: 'Internal maintenance',
        metadata: { internalInput: { actor: 'harness', source: 'context-policy' } } },
      { ...opener, id: 'cross', timestamp: -1, content: 'Other session task',
        metadata: { crossSessionMessage: { sourceInstanceId: 'source', sourceDisplayName: 'Source', hopCount: 1 } } },
      opener,
    ];
    list.addInstance(raw([followup], { retainedPrompts }));
    expect(resolveEffectiveInstanceTitle(state.getInstance('title-instance')!)).toBe(opener.content);
  });

  it('uses an earlier scroll-loaded opener ahead of newer retained prompts', () => {
    list.addInstance(raw([followup], { retainedPrompts: [{ ...followup, timestamp: 2 }] }));
    output.prependOlderMessages('title-instance', [opener]);
    expect(resolveEffectiveInstanceTitle(state.getInstance('title-instance')!)).toBe(opener.content);
  });

  it('leaves a useful established automatic title stable across eviction', () => {
    list.addInstance(raw([opener, ...traffic()], { displayName: 'Watchdog readiness diagnosis' }));
    output.queueOutput('title-instance', followup);
    output.flushInstanceOutput('title-instance');
    expect(resolveEffectiveInstanceTitle(state.getInstance('title-instance')!)).toBe('Watchdog readiness diagnosis');
  });
});
