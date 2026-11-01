import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { InboxComponent } from './inbox.component';
import { NeedsYouStore, type NeedsYouItem } from './needs-you.store';

const items: NeedsYouItem[] = [
  {
    key: 'host-a:prompt:a', kind: 'prompt', hostId: 'host-a', hostName: 'Studio',
    instanceId: 'session-a', workingDirectory: '/work/a', title: 'Allow edit',
    message: 'Review the change', createdAt: 2,
  },
  {
    key: 'host-b:completion:b', kind: 'completion', hostId: 'host-b', hostName: 'Studio',
    instanceId: 'session-b', workingDirectory: '/work/b', title: 'Build finished',
    message: 'Ready to review', createdAt: 1,
  },
];

function render(rows = items, clearState: 'idle' | 'clearing' | 'failed' = 'idle') {
  const open = vi.fn();
  const clearFinished = vi.fn();
  const forgetClearFailure = vi.fn();
  const navigate = vi.fn();
  const inboxItems = signal(rows);
  const hostStates = signal([
    { id: 'host-a', name: 'Studio', status: 'online' as const },
    { id: 'host-b', name: 'Studio', status: 'offline' as const },
  ]);
  TestBed.configureTestingModule({ imports: [InboxComponent], providers: [
    { provide: NeedsYouStore, useValue: { items: inboxItems, hostStates, open, clearFinished, clearStatus: signal(clearState), forgetClearFailure } },
    { provide: Router, useValue: { navigate } },
  ] });
  TestBed.overrideComponent(InboxComponent, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA] } });
  const fixture = TestBed.createComponent(InboxComponent);
  fixture.detectChanges();
  return { fixture, open, navigate, inboxItems, clearFinished, forgetClearFailure };
}

describe('InboxComponent', () => {
  it('renders every host label and measured offline state even when names collide', () => {
    const { fixture } = render();
    const rows = fixture.nativeElement.querySelectorAll('.inbox-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Studio');
    expect(rows[1].textContent).toContain('Studio');
    expect(fixture.nativeElement.textContent).toContain('1 host offline');
  });

  it('opens the exact row and offers a real Projects navigation entry', () => {
    const { fixture, open, navigate } = render();
    fixture.nativeElement.querySelectorAll('.inbox-row')[1].click();
    expect(open).toHaveBeenCalledWith(items[1]);
    fixture.nativeElement.querySelector('[aria-label="Back to projects"]').click();
    expect(navigate).toHaveBeenCalledWith(['/projects']);
  });

  it('shows an explicit empty state', () => {
    const { fixture } = render([]);
    expect(fixture.nativeElement.textContent).toContain('Nothing needs you right now');
  });

  it('puts questions above finished sessions even when a session finished more recently', () => {
    const { fixture } = render([{ ...items[1]!, createdAt: 9 }, items[0]!]);
    const root = fixture.nativeElement as HTMLElement;
    const headings = [...root.querySelectorAll('.inbox-title')].map((heading) => heading.textContent?.trim());
    expect(headings).toEqual(['Waiting for your answer', 'Finished']);
    expect(root.querySelectorAll('.inbox-row')[0].textContent).toContain('Allow edit');
  });

  it('marks every finished session read from one button, and says so when that fails', () => {
    const { fixture, clearFinished } = render();
    const button = [...fixture.nativeElement.querySelectorAll('button')]
      .find((candidate: HTMLButtonElement) => candidate.textContent?.includes('Mark all read')) as HTMLButtonElement;
    button.click();
    expect(clearFinished).toHaveBeenCalledOnce();
    TestBed.resetTestingModule();

    const failed = render(items, 'failed');
    expect(failed.fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain('Some could not be marked read. Check the connection, or update Harness on that Mac');
    failed.fixture.destroy();
    expect(failed.forgetClearFailure).toHaveBeenCalledOnce();
  });

  it('keeps one page heading for screen readers above the sections', () => {
    const { fixture } = render();
    expect(fixture.nativeElement.querySelectorAll('h1')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('h1')?.textContent).toBe('Needs you');
  });

  it('offers no Mark all read button when only questions are waiting', () => {
    const { fixture } = render([items[0]!]);
    expect(fixture.nativeElement.textContent).not.toContain('Mark all read');
  });
});
