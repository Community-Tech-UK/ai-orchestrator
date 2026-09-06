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
import { describe, expect, it } from 'vitest';

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



/**
 * The reimplemented-stand-in block that used to live here has been DELETED.
 *
 * The Wave 6 gate was right about it: it rebuilt `pendingTerminateId`,
 * `onTerminateInstance`, `confirmTerminate` and `cancelTerminate` from scratch
 * and tested the copy, so all seven of its tests would have passed with the real
 * component's confirmation logic removed. This file's own header claimed that
 * anti-pattern had been fixed — true of the source-assertion block above, and
 * not true of the block below it.
 *
 * What replaces it is source assertions covering the paths that were actually
 * broken, both found by that gate.
 */
describe('every terminate path goes through the confirmation (Decision 16b)', () => {
  it('the context menu no longer calls the store directly', () => {
    const menu = COMPONENT.slice(
      COMPONENT.indexOf("id: 'terminate-session'"),
      COMPONENT.indexOf("id: 'terminate-session'") + 600,
    );
    expect(menu).toContain('this.onTerminateInstance(instance.id)');
    expect(menu).not.toContain('this.store.terminateInstance(instance.id)');
  });

  it('exactly one place in the component reaches the store', () => {
    const calls = COMPONENT.match(/this\.store\.terminateInstance\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  /**
   * The overlay's own `(keydown.escape)` only fires when it holds focus, and
   * nothing focuses it — so dismissal has to be handled by the component's
   * existing document-level listener, where every other overlay already is.
   */
  it('Escape is handled by the document listener, not only the overlay binding', () => {
    const handler = COMPONENT.slice(
      COMPONENT.indexOf('onDocumentKeyDown('),
      COMPONENT.indexOf('onDocumentKeyDown(') + 1200,
    );
    expect(handler).toContain('pendingTerminateId()');
    expect(handler).toContain('cancelTerminate()');
  });
});
