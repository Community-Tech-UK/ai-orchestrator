import { describe, expect, it } from 'vitest';
import { isBroadWorkspaceRoot } from '../broad-workspace-roots';

describe('isBroadWorkspaceRoot', () => {
  const home = '/Users/alex';

  it.each([
    '/',
    '/Users',
    '/Users/alex',
    '/Users/alex/',
    '/Users/alex/work',
    '/private/tmp',
    '/tmp',
  ])('treats %s as too broad to index', (workspacePath) => {
    expect(isBroadWorkspaceRoot(workspacePath, home)).toBe(true);
  });

  it.each([
    '/Users/alex/work/project',
    '/Users/alex/work/client/app',
    '/Users/alex/Documents',
    '/private/tmp/checkout',
  ])('allows %s', (workspacePath) => {
    expect(isBroadWorkspaceRoot(workspacePath, home, '/var/folders/xy/T')).toBe(false);
  });

  it('treats the user temp folder itself as too broad, but not folders inside it', () => {
    expect(isBroadWorkspaceRoot('/var/folders/xy/T/', home, '/var/folders/xy/T')).toBe(true);
    expect(isBroadWorkspaceRoot('/var/folders/xy/T/checkout', home, '/var/folders/xy/T')).toBe(false);
  });
});
