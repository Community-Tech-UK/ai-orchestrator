import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ProjectsComponent structure', () => {
  const source = readFileSync(resolve('src/app/features/projects/projects.component.ts'), 'utf8');

  it('renders the shared header and inline session rows', () => {
    expect(source).toContain('<app-mobile-header');
    expect(source).toContain('<app-mobile-session-row');
    expect(source).toContain('projectComposeAriaLabel(group.project)');
  });

  it('uses a search and New bottom dock instead of rollup pills and a detached fab', () => {
    expect(source).toContain('class="mobile-bottom-dock"');
    expect(source).toContain('aria-label="Search sessions"');
    expect(source).not.toContain('class="rollup"');
    expect(source).not.toContain('class="fab"');
  });

  it('keeps offline recovery and active-press ordering explicit', () => {
    expect(source).toContain('Connection unavailable');
    expect(source).toContain('beginRowPress()');
    expect(source).toContain('releaseRowPress()');
    expect(source).toContain('(pointerup)="scheduleRowPressRelease()"');
    expect(source).toContain('(click)="toggleProject(group.project.key); releaseRowPress()"');
    expect(source).toContain('protected openSession(projectKey: string, session: MobileSessionRowView): void {\n    this.releaseRowPress();');
    expect(source).not.toContain('(pointerup)="releaseRowPress()"');
  });
});
