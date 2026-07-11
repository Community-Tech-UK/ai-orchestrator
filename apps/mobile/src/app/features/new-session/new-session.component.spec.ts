import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('NewSessionComponent structure', () => {
  const source = readFileSync(
    resolve('src/app/features/new-session/new-session.component.ts'),
    'utf8',
  );

  it('uses context selectors and one keyboard-anchored composer', () => {
    expect(source).toContain('class="session-context"');
    expect(source).toContain('class="new-session-composer"');
    expect(source).toContain('placeholder="Ask Harness"');
    expect(source).not.toContain('class="providers"');
    expect(source).not.toContain('class="cta"');
  });

  it('progressively discloses directory, settings, and attachment sheets', () => {
    expect(source).toContain('label="Working directory"');
    expect(source).toContain('label="Session settings"');
    expect(source).toContain('label="Add attachment"');
    expect(source).toContain('directorySheetOpen');
    expect(source).toContain('settingsSheetOpen');
    expect(source).toContain('attachmentSheetOpen');
  });

  it('keeps errors next to the composer and starts through form submission', () => {
    expect(source).toContain('role="alert"');
    expect(source).toContain('(submit)="create($event)"');
    expect(source).toContain('buildCreateInstanceRequest');
  });
});
