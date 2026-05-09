import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { LoopPanelOpenerService } from './loop-panel-opener.service';

describe('LoopPanelOpenerService', () => {
  let service: LoopPanelOpenerService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [LoopPanelOpenerService] });
    service = TestBed.inject(LoopPanelOpenerService);
    service._resetForTesting();
  });

  it('starts with no pending request', () => {
    expect(service.pending()).toBeNull();
  });

  it('publishes a request via open() and exposes it on pending()', () => {
    service.open('chat-1', { seedMessage: 'goal', seedPrompt: 'continue' });
    const pending = service.pending();
    expect(pending).not.toBeNull();
    expect(pending?.chatId).toBe('chat-1');
    expect(pending?.seedMessage).toBe('goal');
    expect(pending?.seedPrompt).toBe('continue');
    expect(pending?.source).toBe('manual');
  });

  it('respects an explicit source value', () => {
    service.open('chat-2', { seedPrompt: 'p', source: 'reattempt-past-run' });
    expect(service.pending()?.source).toBe('reattempt-past-run');
  });

  it('ignores empty chat ids', () => {
    service.open('', { seedPrompt: 'whatever' });
    expect(service.pending()).toBeNull();
  });

  it('issues a fresh id on every open() so consumers re-fire on repeats', () => {
    service.open('chat-1', { seedPrompt: 'a' });
    const firstId = service.pending()?.id;
    service.open('chat-1', { seedPrompt: 'a' });
    const secondId = service.pending()?.id;
    expect(firstId).not.toBeUndefined();
    expect(secondId).not.toBeUndefined();
    expect(secondId).not.toBe(firstId);
  });

  it('consume() returns and clears the request when chatId matches', () => {
    service.open('chat-1', { seedPrompt: 'p' });
    const consumed = service.consume('chat-1');
    expect(consumed?.chatId).toBe('chat-1');
    expect(service.pending()).toBeNull();
  });

  it('consume() leaves the request intact when chatId does NOT match', () => {
    service.open('chat-1', { seedPrompt: 'p' });
    expect(service.consume('chat-2')).toBeNull();
    // Still pending for chat-1
    expect(service.pending()?.chatId).toBe('chat-1');
  });

  it('consume() returns null when there is no pending request', () => {
    expect(service.consume('chat-1')).toBeNull();
  });

  it('latest open() supersedes the previous unconsumed one', () => {
    service.open('chat-1', { seedPrompt: 'first' });
    service.open('chat-1', { seedPrompt: 'second' });
    expect(service.pending()?.seedPrompt).toBe('second');
  });

  it('_resetForTesting() clears state and resets the id counter', () => {
    service.open('chat-1', { seedPrompt: 'p' });
    const firstId = service.pending()?.id;
    service._resetForTesting();
    expect(service.pending()).toBeNull();
    service.open('chat-1', { seedPrompt: 'p' });
    const idAfterReset = service.pending()?.id;
    // After reset the counter starts again from 1 → same id format as the
    // first issued one.
    expect(idAfterReset).toBe(firstId);
  });
});
