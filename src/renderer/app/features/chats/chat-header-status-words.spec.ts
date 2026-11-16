/**
 * The chat header, and the session pickers on the worktree, workflow and
 * review pages, must show the shared status words, never the raw status code.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { presentInstanceStatus } from '../../../../shared/attention/instance-status-presentation';

const directory = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(directory, relative), 'utf8');

describe('session status words in the renderer', () => {
  it('the chat header shows the presenter label, not instance.status', () => {
    const template = read('./chat-detail.component.html');
    expect(template).not.toMatch(/\{\{\s*instance\.status\s*\}\}/);
    expect(template).toContain('{{ statusLabel }}');
    expect(read('./chat-detail.component.ts')).toContain(
      'presentInstanceStatus(instance.status, instance.waitReason).label',
    );
  });

  it.each(['../worktree/worktree-page', '../workflow/workflow-page', '../review/reviews-page'])(
    '%s picker shows the presenter label',
    (page) => {
      const source = read(`${page}.component.ts`);
      expect(source).not.toMatch(/\(\{\{\s*instance\.status\s*\}\}\)/);
      expect(source).toContain('statusLabel(instance.status)');
    },
  );

  it('a permission wait reads as a plain phrase', () => {
    expect(presentInstanceStatus('waiting_for_permission').label).not.toMatch(/_/);
  });
});
