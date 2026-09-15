import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPresentationStore } from './approval-presentation.store';
import { GatewayClient } from './gateway-client.service';
import { HapticsService } from './haptics.service';
import { HostStore } from './host-store';
import type { MobilePromptDto, MobileSnapshot, PairedHost } from './models';

const HOST: PairedHost = { id: 'host-a', name: 'Preview host', host: 'preview.invalid', port: 8899, token: 'PLACEHOLDER', addedAt: 0 };
const PROMPT: MobilePromptDto = { id: 'prompt-a', requestId: 'request-a', instanceId: 'session-a', kind: 'user-action', requestType: 'ask_questions', title: 'A question', message: 'Please answer', questions: ['What next?'], createdAt: 1 };

describe('ApprovalPresentationStore', () => {
  const activeHost = signal<PairedHost | null>(HOST);
  const dataHostId = signal<string | null>(HOST.id);
  const prompts = signal<MobilePromptDto[]>([]);
  const snapshot = signal<MobileSnapshot | null>(null);
  const respond = vi.fn<() => Promise<void>>();
  const success = vi.fn();
  let store: ApprovalPresentationStore;

  beforeEach(() => {
    activeHost.set(HOST);
    dataHostId.set(HOST.id);
    prompts.set([PROMPT]);
    snapshot.set(null);
    respond.mockReset().mockResolvedValue(undefined);
    success.mockReset();
    TestBed.configureTestingModule({ providers: [
      { provide: HostStore, useValue: { activeHost } },
      { provide: GatewayClient, useValue: { dataHostId, prompts, snapshot, respond } },
      { provide: HapticsService, useValue: { success, warning: vi.fn(), error: vi.fn() } },
    ] });
    store = TestBed.inject(ApprovalPresentationStore);
    TestBed.tick();
  });

  it('keeps answers, scope and selection through equivalent snapshots and new requests', () => {
    store.updateAnswer(0, 'Keep this answer');
    store.setScope('session');
    prompts.set([{ ...PROMPT }, { ...PROMPT, id: 'prompt-b', requestId: 'request-b' }]);
    TestBed.tick();
    expect(store.activePrompt()?.id).toBe('prompt-a');
    expect(store.draft()).toEqual({ scope: 'session', answers: { 0: 'Keep this answer' } });
    expect(store.requests()).toHaveLength(2);
  });

  it('reopens the exact Later request with its answer and keeps the queue available', () => {
    prompts.set([PROMPT, { ...PROMPT, id: 'prompt-b', requestId: 'request-b' }]);
    store.open('prompt-b');
    store.updateAnswer(0, 'Second answer');
    store.dismiss();
    TestBed.tick();
    expect(store.activePrompt()).toBeNull();
    expect(store.requests()).toHaveLength(2);
    store.open();
    expect(store.activePrompt()?.id).toBe('prompt-b');
    expect(store.draft().answers[0]).toBe('Second answer');
  });

  it('sends once while pending, keeps a rejected answer and permits retry', async () => {
    let reject!: (error: Error) => void;
    respond.mockReturnValueOnce(new Promise<void>((_resolve, fail) => { reject = fail; }));
    store.updateAnswer(0, 'Keep on rejection');
    const decision = { action: 'allow' as const, scope: 'once' as const, response: '{"What next?":"Keep on rejection"}' };
    const first = store.decide(decision);
    await store.decide(decision);
    expect(store.pending()).toBe(true);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(success).not.toHaveBeenCalled();
    reject(new Error('Host rejected the response'));
    await first;
    expect(store.pending()).toBe(false);
    expect(store.error()).toBe('Host rejected the response');
    expect(store.draft().answers[0]).toBe('Keep on rejection');
    await store.decide(decision);
    expect(respond).toHaveBeenCalledTimes(2);
    expect(success).toHaveBeenCalledTimes(1);
    expect(store.requests()).toEqual([]);
  });

  it('hides stale host data immediately and never submits it to the new host', async () => {
    store.updateAnswer(0, 'Host A only');
    activeHost.set({ ...HOST, id: 'host-b', name: 'Other host' });
    expect(store.requests()).toEqual([]);
    expect(store.activePrompt()).toBeNull();
    await store.decide({ action: 'allow', scope: 'once' });
    expect(respond).not.toHaveBeenCalled();
    dataHostId.set('host-b');
    prompts.set([{ ...PROMPT }]);
    TestBed.tick();
    expect(store.draft().answers).toEqual({});
  });

  it('does not move a delayed failure onto another host with identical request IDs', async () => {
    let reject!: (error: Error) => void;
    respond.mockReturnValueOnce(new Promise<void>((_resolve, fail) => { reject = fail; }));
    const first = store.decide({ action: 'allow', scope: 'once' });
    activeHost.set({ ...HOST, id: 'host-b' });
    dataHostId.set('host-b');
    prompts.set([{ ...PROMPT }]);
    TestBed.tick();
    reject(new Error('Old host failure'));
    await first;
    expect(store.activePrompt()?.id).toBe(PROMPT.id);
    expect(store.pending()).toBe(false);
    expect(store.error()).toBeNull();
    expect(success).not.toHaveBeenCalled();
  });

  it('does not remove another request or announce success after switching hosts', async () => {
    let release!: () => void;
    respond.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
    const first = store.decide({ action: 'allow', scope: 'once' });
    activeHost.set({ ...HOST, id: 'host-b' });
    dataHostId.set('host-b');
    TestBed.tick();
    release();
    await first;
    expect(store.requests()).toHaveLength(1);
    expect(success).not.toHaveBeenCalled();
  });

  it('keys drafts by session and request identity even if the presentation ID is reused', () => {
    store.updateAnswer(0, 'Original request');
    prompts.set([{ ...PROMPT, instanceId: 'session-b', requestId: 'request-b' }]);
    TestBed.tick();
    expect(store.draft().answers).toEqual({});
  });

  it('rejects an event from a stale rendered sheet after a host switch', async () => {
    const oldView = store.view();
    activeHost.set({ ...HOST, id: 'host-b' });
    dataHostId.set('host-b');
    prompts.set([{ ...PROMPT }]);
    TestBed.tick();
    await store.decide({ action: 'allow', scope: 'always' }, oldView);
    expect(respond).not.toHaveBeenCalled();
  });

  it('keeps per-host drafts when switching away and back', () => {
    store.updateAnswer(0, 'Host A draft');
    activeHost.set({ ...HOST, id: 'host-b' });
    dataHostId.set('host-b');
    prompts.set([{ ...PROMPT }]);
    TestBed.tick();
    store.updateAnswer(0, 'Host B draft');
    activeHost.set(HOST);
    dataHostId.set(HOST.id);
    prompts.set([{ ...PROMPT }]);
    TestBed.tick();
    expect(store.draft().answers[0]).toBe('Host A draft');
  });
});
