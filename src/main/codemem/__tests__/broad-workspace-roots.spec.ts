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
    expect(isBroadWorkspaceRoot(workspacePath, home)).toBe(false);
  });
});
