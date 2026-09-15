import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftStore } from './draft-store';
import { ConversationDraftRecoveryService } from './conversation-draft-recovery.service';
import type { MobileAttachmentDto } from './models';

describe('Conversation draft recovery across navigation', () => {
  const text = new Map<string, string>();
  const images = new Map<string, MobileAttachmentDto[]>();
  const photo = { name: 'image.jpg', type: 'image/jpeg', size: 1, data: 'image-placeholder' };
  let recovery: ConversationDraftRecoveryService;
  beforeEach(() => {
    text.clear(); images.clear();
    TestBed.configureTestingModule({ providers: [{ provide: DraftStore, useValue: {
      load: async (key: string) => text.get(key) ?? '',
      save: (key: string, value: string) => text.set(key, value),
      clear: (key: string) => text.delete(key),
      attachments: (key: string) => images.get(key) ?? [],
      saveAttachments: (key: string, value: MobileAttachmentDto[]) => images.set(key, value),
    } }] });
    recovery = TestBed.inject(ConversationDraftRecoveryService);
  });

  it('routes delayed recovery to a recreated composer, preserving its ownership after old teardown', async () => {
    const old = vi.fn().mockResolvedValue(true);
    const detachOld = recovery.attach('host-a/session', old);
    const current = vi.fn().mockResolvedValue(true);
    recovery.attach('host-a/session', current);
    detachOld();
    await recovery.recover('host-a/session', 'Recovered request', [photo]);
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledExactlyOnceWith('Recovered request', [photo]);
  });

  it('rechecks the active composer after an old composer finishes its initial load', async () => {
    let release!: (accepted: boolean) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    recovery.attach('host-a/session', () => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const pending = recovery.recover('host-a/session', 'Recovered request', [photo]);
    await waiting;
    const next = vi.fn().mockResolvedValue(true);
    recovery.attach('host-a/session', next);
    release(false);
    await pending;
    expect(next).toHaveBeenCalledExactlyOnceWith('Recovered request', [photo]);
  });

  it('serializes stored recovery and preserves text/photos on the original host only', async () => {
    text.set('host-a/session', 'Already drafted'); images.set('host-a/session', [photo]);
    const otherHost = vi.fn().mockResolvedValue(true);
    recovery.attach('host-b/session', otherHost);
    await Promise.all([
      recovery.recover('host-a/session', 'First return', [photo]),
      recovery.recover('host-a/session', 'Second return', []),
    ]);
    expect(text.get('host-a/session')).toBe('Already drafted\n\nFirst return\n\nSecond return');
    expect(images.get('host-a/session')).toHaveLength(2);
    expect(otherHost).not.toHaveBeenCalled();
  });

  it('runs a structured fallback for config-only recovery without appending raw JSON', async () => {
    text.set('new-session:host-a', '{"text":"Stored","provider":"auto"}');
    const merge = vi.fn((saved: string) => saved.replace('auto', 'codex'));
    await recovery.recover('new-session:host-a', '', [], merge);
    expect(merge).toHaveBeenCalledExactlyOnceWith('{"text":"Stored","provider":"auto"}', '');
    expect(text.get('new-session:host-a')).toBe('{"text":"Stored","provider":"codex"}');
  });

  it('lets an active structured composer handle recovery without applying stale config', async () => {
    const receiver = vi.fn().mockResolvedValue(true);
    const merge = vi.fn();
    recovery.attach('new-session:host-a', receiver);
    await recovery.recover('new-session:host-a', '', [], merge);
    expect(receiver).toHaveBeenCalledExactlyOnceWith('', []);
    expect(merge).not.toHaveBeenCalled();
    expect(text.has('new-session:host-a')).toBe(false);
  });

  it('consumes a legacy draft only once when explicitly recovered', async () => {
    text.set('instance:session', 'Older request');
    text.set('host-a/session', 'New request');
    const results = await Promise.all([
      recovery.recoverLegacy('host-a/session', 'instance:session'),
      recovery.recoverLegacy('host-b/session', 'instance:session'),
    ]);
    expect(results).toEqual([true, false]);
    expect(text.get('host-a/session')).toBe('New request\n\nOlder request');
    expect(text.has('host-b/session')).toBe(false);
    expect(text.has('instance:session')).toBe(false);
  });
});
