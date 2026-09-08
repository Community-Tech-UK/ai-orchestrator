/**
 * Decision 16(b) — terminating a session asks first, from every entry point.
 *
 * History worth keeping, because each version of this file was wrong in a way
 * the next one had to fix:
 *
 * 1. The first version re-implemented the handlers and tested the copy. It would
 *    have passed with the component deleted.
 * 2. The second read the real source, but only `instance-list.component.ts`.
 *    Its headline assertion — "exactly one place reaches the store" — counted
 *    matches inside that single file, so it was true of the file and false of
 *    the app: the `close-instance` action in `dashboard.component.ts`, bound to
 *    **Cmd+W** by default, still called `store.terminateInstance` outright. A
 *    file-scoped scan can never see a path in another file, so the test was
 *    structurally incapable of catching the thing it claimed to cover.
 *
 * This version scans the whole renderer and pins the complete set of call sites.
 * A new one fails here by construction, wherever it is added.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const RENDERER = join(ROOT, 'src/renderer');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.(ts|html)$/.test(entry.name)) return [];
    if (entry.name.includes('.spec.')) return [];
    return [full];
  });
}

const STORE = readFileSync(join(__dirname, 'terminate-confirm.store.ts'), 'utf8');
const DIALOG = readFileSync(join(__dirname, 'terminate-confirm-dialog.component.ts'), 'utf8');

/**
 * Call sites permitted to end a session without the confirmation, each with the
 * reason. This list is the review surface: adding to it is a decision, and it is
 * visible in a diff.
 */
const ALLOWED_UNCONFIRMED: readonly { file: string; why: string }[] = [
  {
    // The plumbing itself, not an entry point.
    file: 'app/core/state/instance/instance-list.store.ts',
    why: 'the store method being wrapped',
  },
  {
    file: 'app/core/state/instance/instance.store.ts',
    why: 'facade delegating to the list store',
  },
  {
    file: 'app/core/state/instance/instance-respawn-watchdog.ts',
    why: 'watchdog recovery for an instance already stuck in respawning',
  },
  {
    file: 'app/core/services/ipc/instance-ipc.service.ts',
    why: 'the IPC call itself',
  },
  {
    file: 'app/shared/terminate-confirm/terminate-confirm.store.ts',
    why: 'the confirmed path — this is where a confirmed terminate lands',
  },
  {
    // Not a user-initiated destructive action: the interrupt was rejected, and
    // this force-terminates then immediately restarts so the session is not
    // stranded. Prompting here would ask the user to approve a repair they did
    // not request, for a session that continues to exist afterwards.
    file: 'app/features/instance-detail/instance-detail.component.ts',
    why: 'force-terminate + restart recovery after a rejected interrupt',
  },
];

describe('every terminate path in the renderer is accounted for (Decision 16b)', () => {
  it('no call site outside the allowlist can end a session', () => {
    const offenders = sourceFiles(RENDERER)
      .filter((file) => /\bterminateInstance\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(RENDERER, file).split(/[\\/]/).join('/'))
      .filter((rel) => !ALLOWED_UNCONFIRMED.some((a) => a.file === rel));

    expect(offenders).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    const present = new Set(
      sourceFiles(RENDERER)
        .filter((file) => /\bterminateInstance\(/.test(readFileSync(file, 'utf8')))
        .map((file) => relative(RENDERER, file).split(/[\\/]/).join('/')),
    );
    const stale = ALLOWED_UNCONFIRMED.filter((a) => !present.has(a.file)).map((a) => a.file);
    expect(stale).toEqual([]);
  });

  it('the row button and the Cmd+W action both route through the store', () => {
    const list = readFileSync(
      join(ROOT, 'src/renderer/app/features/instance-list/instance-list.component.ts'),
      'utf8',
    );
    const dashboard = readFileSync(
      join(ROOT, 'src/renderer/app/features/dashboard/dashboard.component.ts'),
      'utf8',
    );

    const handler = list.slice(
      list.indexOf('onTerminateInstance(instanceId: string)'),
      list.indexOf('onTerminateInstance(instanceId: string)') + 200,
    );
    expect(handler).toContain('terminateConfirm.request(instanceId)');

    const action = dashboard.slice(
      dashboard.indexOf("id: 'close-instance'"),
      dashboard.indexOf("id: 'close-instance'") + 600,
    );
    expect(action).toContain('terminateConfirm.request(instance.id)');
    expect(action).not.toContain('store.terminateInstance(');
  });

  it('the context menu routes through the same handler', () => {
    const list = readFileSync(
      join(ROOT, 'src/renderer/app/features/instance-list/instance-list.component.ts'),
      'utf8',
    );
    const menu = list.slice(
      list.indexOf("id: 'terminate-session'"),
      list.indexOf("id: 'terminate-session'") + 600,
    );
    expect(menu).toContain('this.onTerminateInstance(instance.id)');
  });
});

describe('the confirmation itself', () => {
  it('only confirm() reaches the store, and request() does not', () => {
    const request = STORE.slice(STORE.indexOf('request(instanceId: string)'), STORE.indexOf('confirm()'));
    expect(request).not.toContain('terminateInstance(');

    const confirm = STORE.slice(STORE.indexOf('confirm()'), STORE.indexOf('cancel()'));
    expect(confirm).toContain('this.instances.terminateInstance(id)');
  });

  it('renders a real modal, offers a way out, and says what is lost', () => {
    expect(DIALOG).toContain('aria-modal="true"');
    expect(DIALOG).toContain('Keep running');
    expect(DIALOG).toContain('written to disk is lost');
    // The prompt used to claim the session "cannot be resumed". Terminating
    // archives the thread (instance-termination.ts archiveRootConversation) and
    // the resume picker offers resumeById/forkNew on that entry, so the claim
    // was false. Pin it out rather than let it drift back in.
    expect(DIALOG).not.toContain('cannot be resumed');
  });

  /**
   * The overlay's own `(keydown.escape)` only fires when it holds focus, and
   * nothing focused it — which is exactly how Escape came to do nothing the
   * first time. So the document listener is required, and the overlay binding
   * is only allowed to exist alongside something that actually moves focus into
   * the dialog. Both halves are asserted, because the binding on its own is the
   * original bug.
   */
  it('Escape is handled on document, which fires regardless of focus', () => {
    expect(DIALOG).toContain("@HostListener('document:keydown'");
  });

  it('the overlay Escape binding is not decorative — the dialog takes focus', () => {
    expect(DIALOG).toContain('(keydown.escape)="');
    expect(DIALOG).toContain('nativeElement.focus()');
  });

  /**
   * The dialog is mounted at app level rather than inside the instance list.
   * The sidebar that hosts the list is collapsible, so a dialog rendered there
   * would make Cmd+W appear to do nothing whenever the sidebar was hidden.
   */
  it('is mounted app-wide, outside the collapsible sidebar', () => {
    const appHtml = readFileSync(join(ROOT, 'src/renderer/app/app.component.html'), 'utf8');
    expect(appHtml).toContain('<app-terminate-confirm-dialog />');

    const listHtml = readFileSync(
      join(ROOT, 'src/renderer/app/features/instance-list/instance-list.component.html'),
      'utf8',
    );
    expect(listHtml).not.toContain('terminate-confirm-title');
  });
});
