import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
describe('single task display wiring', () => {
  it('mounts Progress for every live session view and removes the duplicate inspector', () => {
    const template = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), './instance-detail.component.html'), 'utf8');
    expect(template.match(/<app-session-progress-panel\b/g)).toHaveLength(1);
    expect(template).not.toContain('<app-todo-list'); expect(template).not.toContain('showTodoInspector');
    const dashboard = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../dashboard/dashboard.component.html'), 'utf8');
    expect(dashboard).not.toContain('<app-session-progress-panel');
  });
});
