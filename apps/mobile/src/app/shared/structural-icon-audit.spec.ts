import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = [
  'features/hosts/hosts.component.ts',
  'features/hosts/add-host.component.ts',
  'features/projects/projects.component.ts',
  'features/sessions/sessions.component.ts',
  'features/new-session/new-session.component.ts',
  'features/history/history.component.ts',
  'features/history/history-detail.component.ts',
  'features/conversation/conversation.component.ts',
  'features/lock/lock-screen.component.ts',
];

describe('structural icon audit', () => {
  it.each(files)('%s uses vector components instead of structural glyphs', (file) => {
    const source = readFileSync(resolve('src/app', file), 'utf8');
    expect(source).not.toMatch(/[☰🕘🗀🔧📎🔒⛶▶⏸‹›＋]/u);
  });

  it.each([
    'features/conversation/conversation.component.ts',
    'features/history/history-detail.component.ts',
  ])('%s labels expandable tool groups', (file) => {
    const source = readFileSync(resolve('src/app', file), 'utf8');
    expect(source).toContain('[attr.aria-label]="toolGroupLabel(item)"');
    expect(source).not.toContain('🔧');
  });

  it('expresses attachment state with icon plus text', () => {
    const source = readFileSync(
      resolve('src/app/features/conversation/conversation.component.ts'),
      'utf8',
    );
    expect(source).toContain('<app-mobile-icon name="attachment" />');
    expect(source).toContain('Photo attached');
    expect(source).not.toContain('📎');
  });
});
