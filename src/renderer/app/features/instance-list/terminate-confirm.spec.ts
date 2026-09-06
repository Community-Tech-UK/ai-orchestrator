/**
 * Decision 16(b) — Terminate now confirms.
 *
 * Before this, `onTerminateInstance` called `store.terminateInstance` directly:
 * one click, irreversible, with only a hover tooltip as warning — which is
 * invisible to keyboard and screen-reader users, and which the tooltip house
 * rules say must not be the only carrier of a destructive consequence.
 *
 * The first version of this file re-implemented the handlers and tested the
 * copy — it would have passed with the component deleted. These read the real
 * source instead, which is mechanical but actually anchored to the shipped code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const COMPONENT = readFileSync(
  join(ROOT, 'src/renderer/app/features/instance-list/instance-list.component.ts'),
  'utf8',
);
const TEMPLATE = readFileSync(
  join(ROOT, 'src/renderer/app/features/instance-list/instance-list.component.html'),
  'utf8',
);

describe('the shipped component actually defers termination (Decision 16b)', () => {
  /** The regression this exists to prevent: a direct call from the click handler. */
  it('onTerminateInstance does not call the store directly', () => {
    const handler = COMPONENT.slice(
      COMPONENT.indexOf('onTerminateInstance(instanceId: string)'),
      COMPONENT.indexOf('confirmTerminate()'),
    );
    expect(handler).not.toContain('terminateInstance(instanceId)');
    expect(handler).toContain('pendingTerminateId.set(instanceId)');
  });

  it('only confirmTerminate reaches the store', () => {
    const confirm = COMPONENT.slice(
      COMPONENT.indexOf('confirmTerminate()'),
      COMPONENT.indexOf('cancelTerminate()'),
    );
    expect(confirm).toContain('this.store.terminateInstance(id)');
  });

  it('renders a real modal dialog, not a bare button', () => {
    expect(TEMPLATE).toContain('aria-modal="true"');
    expect(TEMPLATE).toContain('pendingTerminateId()');
  });

  it('offers a non-destructive way out and says what is lost', () => {
    expect(TEMPLATE).toContain('Keep running');
    expect(TEMPLATE).toContain('cannot be resumed');
  });

  it('closes on Escape rather than trapping the user', () => {
    expect(TEMPLATE).toContain('(keydown.escape)="cancelTerminate()"');
  });
});


import { signal } from '@angular/core';

/**
 * The behavioural contract, exercised against a faithful stand-in. Kept BELOW
 * the source assertions above, which are what tie it to the real component.
 */
interface TerminateHost {
  pendingTerminateId: ReturnType<typeof signal<string | null>>;
  pendingTerminateName: () => string;
  onTerminateInstance: (id: string) => void;
  confirmTerminate: () => void;
  cancelTerminate: () => void;
}

/** Mirrors the component's implementation so the contract is testable in isolation. */
function makeHost(terminate: (id: string) => void, names: Record<string, string> = {}): TerminateHost {
  const pendingTerminateId = signal<string | null>(null);
  return {
    pendingTerminateId,
    pendingTerminateName: () => {
      const id = pendingTerminateId();
      return id ? names[id] ?? 'this session' : '';
    },
    onTerminateInstance: (id) => pendingTerminateId.set(id),
    confirmTerminate: () => {
      const id = pendingTerminateId();
      if (!id) return;
      pendingTerminateId.set(null);
      terminate(id);
    },
    cancelTerminate: () => pendingTerminateId.set(null),
  };
}

describe('terminate confirmation (Decision 16b)', () => {
  it('does NOT terminate on the first click', () => {
    const terminate = vi.fn();
    const host = makeHost(terminate);
    host.onTerminateInstance('inst-1');
    expect(terminate).not.toHaveBeenCalled();
    expect(host.pendingTerminateId()).toBe('inst-1');
  });

  it('terminates only after confirmation', () => {
    const terminate = vi.fn();
    const host = makeHost(terminate);
    host.onTerminateInstance('inst-1');
    host.confirmTerminate();
    expect(terminate).toHaveBeenCalledWith('inst-1');
  });

  it('cancelling terminates nothing and clears the prompt', () => {
    const terminate = vi.fn();
    const host = makeHost(terminate);
    host.onTerminateInstance('inst-1');
    host.cancelTerminate();
    expect(terminate).not.toHaveBeenCalled();
    expect(host.pendingTerminateId()).toBeNull();
  });

  /** A stray confirm with nothing pending must not kill an arbitrary session. */
  it('confirming with nothing pending is a no-op', () => {
    const terminate = vi.fn();
    makeHost(terminate).confirmTerminate();
    expect(terminate).not.toHaveBeenCalled();
  });

  it('names the session so you know which one you are ending', () => {
    const host = makeHost(vi.fn(), { 'inst-1': 'api-refactor' });
    host.onTerminateInstance('inst-1');
    expect(host.pendingTerminateName()).toBe('api-refactor');
  });

  it('falls back to a safe name when the instance is unknown', () => {
    const host = makeHost(vi.fn());
    host.onTerminateInstance('gone');
    expect(host.pendingTerminateName()).toBe('this session');
  });

  it('a second terminate request replaces the pending one rather than queueing', () => {
    const terminate = vi.fn();
    const host = makeHost(terminate);
    host.onTerminateInstance('inst-1');
    host.onTerminateInstance('inst-2');
    host.confirmTerminate();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith('inst-2');
  });
});
