import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectsEmptyStateTitle } from './projects.component';

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

  it('renders an accessible All/Active state filter shared by both organization modes', () => {
    expect(source).toContain('aria-label="Filter sessions by state"');
    expect(source).toContain("[attr.aria-pressed]=\"stateFilter() === 'all'\"");
    expect(source).toContain("[attr.aria-pressed]=\"stateFilter() === 'active'\"");
    expect(source).toContain("(click)=\"setStateFilter('all')\"");
    expect(source).toContain("(click)=\"setStateFilter('active')\"");
    expect(source).toContain('this.stateFilter()');
  });

  it('distinguishes no active results from an empty or unmatched session list', () => {
    expect(projectsEmptyStateTitle('active', '')).toBe('No active sessions');
    expect(projectsEmptyStateTitle('all', 'missing')).toBe('No matching sessions');
    expect(projectsEmptyStateTitle('all', '')).toBe('No projects yet');
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
