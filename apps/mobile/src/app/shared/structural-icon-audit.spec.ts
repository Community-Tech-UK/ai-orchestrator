import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A component's markup, whether it lives in an inline `template:` or a sibling
 * `.html` file. The audit is about what the template renders, so it must follow
 * the template wherever it lives.
 */
function componentSource(file: string): string {
  const ts = resolve('src/app', file);
  const html = ts.replace(/\.ts$/, '.html');
  const parts = [readFileSync(ts, 'utf8')];
  if (existsSync(html)) parts.push(readFileSync(html, 'utf8'));
  return parts.join('\n');
}

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
    const source = componentSource(file);
    expect(source).not.toMatch(/[☰🕘🗀🔧📎🔒⛶▶⏸‹›＋]/u);
  });

  it.each([
    'features/conversation/conversation.component.ts',
    'features/history/history-detail.component.ts',
  ])('%s labels expandable tool groups', (file) => {
    const source = componentSource(file);
    expect(source).toContain('[attr.aria-label]="toolGroupLabel(item)"');
    expect(source).not.toContain('🔧');
  });

  it('expresses attachment state with icon plus text', () => {
    const source = componentSource('features/conversation/conversation.component.ts');
    expect(source).toContain('<app-mobile-icon name="attachment" />');
    expect(source).toContain('Photo attached');
    expect(source).not.toContain('📎');
  });
});
