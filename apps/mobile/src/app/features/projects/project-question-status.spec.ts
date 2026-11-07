import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { MobileInstanceDto } from '../../core/models';
import { MobileSessionRowComponent } from '../../shared/mobile-session-row.component';
import { buildProjectGroups, flattenChronologicalSessions } from './project-list.view-model';

afterEach(() => TestBed.resetTestingModule());

describe('phone question status in both browsing modes', () => {
  it.each([
    ['waiting_for_input', 1, 'Needs your answer'],
    ['waiting_for_permission', 1, 'Needs your approval'],
    ['busy', 1, 'Needs your approval'],
    ['busy', 0, 'Working'],
  ] as const)('renders %s with %i pending approvals as %s', (status, pendingApprovalCount, expected) => {
    const instance: MobileInstanceDto = { id: 'question', displayName: 'Fixture session', status,
      provider: 'claude', workingDirectory: '/work/example', projectName: 'example', createdAt: 1,
      lastActivity: 1, pendingApprovalCount, hasUnreadCompletion: false };
    const groups = buildProjectGroups([], [instance], [], []);
    for (const row of [groups[0].sessions[0], flattenChronologicalSessions(groups)[0]]) {
      const fixture = TestBed.createComponent(MobileSessionRowComponent);
      fixture.componentRef.setInput('row', row);
      fixture.detectChanges();
      const host: HTMLElement = fixture.nativeElement;
      expect(host.querySelector('.session-row__subtitle')?.textContent).toContain(expected);
      expect(host.querySelector('button')?.getAttribute('aria-label')).toBe(`Open Fixture session, ${expected}`);
      fixture.destroy();
    }
  });
});
