import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `HostStore.removeHost()` existed for a long time with no caller — there was no
 * way to delete a paired host from the UI at all, so expired entries accumulated
 * with no way to clear them.
 */
describe('HostsComponent remove control', () => {
  const source = readFileSync(resolve('src/app/features/hosts/hosts.component.ts'), 'utf8');

  it('offers a labelled remove control on every host row', () => {
    expect(source).toContain('(click)="remove(host)"');
    expect(source).toContain(`[attr.aria-label]="'Remove ' + host.name"`);
  });

  it('confirms before discarding the only copy of the device token', () => {
    expect(source).toContain('confirm(');
    expect(source).toContain('this.hostStore.removeHost(host.id)');
  });

  /**
   * Removing a host must also revoke the token on the Mac, or the desktop's
   * paired-device list keeps entries the user already deleted here.
   */
  it('revokes on the host before dropping the local entry', () => {
    expect(source).toContain('await unpairFromHost(host)');
    const revokeAt = source.indexOf('await unpairFromHost(host)');
    const removeAt = source.indexOf('this.hostStore.removeHost(host.id)');
    expect(revokeAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeLessThan(removeAt);
  });

  it('still removes locally when the host is unreachable, and says so', () => {
    // The token can outlive the entry, so the user is told where to finish the job.
    expect(source).toContain('if (!revoked)');
    expect(source).toContain("Revoke it on the Mac under Settings, Mobile, Paired devices.");
    expect(source).toContain('{{ notice() }}');
  });

  it('keeps the remove control outside the row button rather than nested in it', () => {
    // A button inside a button is invalid HTML and swallows the inner tap.
    const rowOpen = source.indexOf('class="host-row mobile-pressable"');
    const rowClose = source.indexOf('</button>', rowOpen);
    const removeAt = source.indexOf('class="host-remove mobile-pressable"');
    expect(removeAt).toBeGreaterThan(rowClose);
  });
});
