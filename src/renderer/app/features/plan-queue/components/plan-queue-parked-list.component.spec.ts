import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueItemDto } from '@contracts/schemas/plan-queue';
import { PlanQueueStore } from '../../../core/state/plan-queue.store';
import { PlanQueueParkedListComponent } from './plan-queue-parked-list.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-parked-list.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-parked-list.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-parked-list.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-parked-list.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeItem(overrides: Partial<PlanQueueItemDto> = {}): PlanQueueItemDto {
  return {
    id: 'item-1',
    runId: 'run-1',
    sourceRef: 'docs/plans/foo_plan.md',
    state: 'parked',
    round: 3,
    erroredRounds: 1,
    branchName: 'plan-queue/foo-plan',
    worktreePath: '/tmp/wt',
    baseCommit: 'abc',
    checkpointCommit: 'def',
    landedCommit: null,
    workerInstanceId: 'inst-worker',
    verifierInstanceId: 'inst-verifier',
    question: null,
    answer: null,
    parkReason: 'round-limit',
    detail: null,
    verdict: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('PlanQueueParkedListComponent', () => {
  let fixture: ComponentFixture<PlanQueueParkedListComponent>;
  const store = { diffstat: vi.fn() };

  function threeProjects(): HTMLElement {
    fixture.componentRef.setInput('runs', [
      { id: 'run-1', workspaceCwd: '/work/small', config: {}, items: [] },
      { id: 'run-2', workspaceCwd: '/work/big', config: {}, items: [] },
      { id: 'run-3', workspaceCwd: '/work/middle', config: {}, items: [] },
    ]);
    fixture.componentRef.setInput('items', [
      makeItem({ id: 'a', runId: 'run-1' }),
      makeItem({ id: 'b', runId: 'run-2', sourceRef: 'docs/plans/b_plan.md' }),
      makeItem({ id: 'c', runId: 'run-2', sourceRef: 'docs/plans/c_plan.md' }),
      makeItem({ id: 'd', runId: 'run-3', sourceRef: 'docs/plans/d_plan.md' }),
    ]);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }
  const projectRows = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>('.pq-sort-out-project')]
    .map((row) => [...row.children].map((part) => part.textContent?.trim()).join(' '));

  it('offers one Sort out button per folder, biggest first, and says what it does', () => {
    const element = threeProjects();
    expect(projectRows(element)).toEqual(['big (2 jobs) Sort out', 'middle (1 job) Sort out', 'small (1 job) Sort out']);
    const help = element.querySelector('.pq-sort-out p')?.textContent ?? '';
    expect(help).toContain('does what it recommends');
    expect(help).toContain('including bugs in Harness');
    expect(help).toContain('can merge without the final checks');
    expect(help).toContain('never pushes');
    expect(help).toContain('use provider usage');
    const started: string[] = [];
    fixture.componentInstance.sortOut.subscribe((folder) => started.push(folder));
    element.querySelector<HTMLButtonElement>('.pq-sort-out-start')!.click();
    expect(started).toEqual(['/work/big']);
  });

  it('sorts out every project at once, skipping any whose agent is already working', () => {
    const element = threeProjects();
    const all: string[][] = [];
    fixture.componentInstance.sortOutAll.subscribe((folders) => all.push(folders));
    const button = () => element.querySelector<HTMLButtonElement>('.pq-sort-out-all');
    expect(button()?.textContent?.trim()).toBe('Sort out all 3 projects');
    button()!.click();
    expect(all).toEqual([['/work/big', '/work/middle', '/work/small']]);

    fixture.componentRef.setInput('agents', new Map([['/work/big', { state: 'working', instanceId: 'agent-big' }]]));
    fixture.detectChanges();
    expect(button()?.textContent?.trim()).toBe('Sort out the other 2 projects');
    button()!.click();
    expect(all[1]).toEqual(['/work/middle', '/work/small']);

    fixture.componentRef.setInput('agents', new Map([
      ['/work/big', { state: 'working', instanceId: 'agent-big' }], ['/work/middle', { state: 'starting', instanceId: null }],
    ]));
    fixture.detectChanges();
    expect(button()).toBeNull();
  });

  it('shows how each agent is getting on, and opens its session only when asked', () => {
    const element = threeProjects();
    fixture.componentRef.setInput('agents', new Map([
      ['/work/big', { state: 'working', instanceId: 'agent-big' }],
      ['/work/middle', { state: 'starting', instanceId: null }],
      ['/work/small', { state: 'finished', instanceId: 'agent-small' }],
    ]));
    fixture.detectChanges();
    expect(projectRows(element)).toEqual([
      'big (2 jobs) Working… Watch it work',
      'middle (1 job) Starting…',
      'small (1 job) Finished Read its report Sort out again',
    ]);
    expect([...element.querySelectorAll('.pq-sort-out-open, .pq-sort-out-start')].map((button) => button.getAttribute('aria-label')))
      .toEqual(['Watch it work: big', 'Read its report: small', 'Sort out again: small']);
    const opened: string[] = [];
    fixture.componentInstance.openAgent.subscribe((id) => opened.push(id));
    const openButtons = [...element.querySelectorAll<HTMLButtonElement>('.pq-sort-out-open')];
    openButtons[1].click();
    expect(opened).toEqual(['agent-small']);

    fixture.componentRef.setInput('agents', new Map([['/work/big', { state: 'stopped', instanceId: 'agent-big' }]]));
    fixture.detectChanges();
    expect(projectRows(element)[0]).toBe('big (2 jobs) Stopped before it finished Open its session Sort out again');
  });

  it('offers no Sort out button when nothing is set aside', () => {
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.pq-sort-out')).toBeNull();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    store.diffstat.mockResolvedValue('1 file changed, 4 insertions(+)');
    await TestBed.configureTestingModule({
      imports: [PlanQueueParkedListComponent],
      providers: [{ provide: PlanQueueStore, useValue: store }],
    }).compileComponents();
    fixture = TestBed.createComponent(PlanQueueParkedListComponent);
  });

  it('shows an empty message with no parked items', () => {
    fixture.componentRef.setInput('items', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No work set aside');
  });

  it('heads multiple ready documents once and keeps them before other set-aside work', () => {
    const verdict = { verdict: 'PASS' as const, findings: [], gatesRun: [], documentComplete: true, needJames: [] };
    fixture.componentRef.setInput('items', [makeItem({ id: 'other', sourceRef: 'other.md', updatedAt: 4 }),
      makeItem({ id: 'first', sourceRef: 'first.md', parkReason: 'land-blocked', verdict }),
      makeItem({ id: 'second', sourceRef: 'second.md', parkReason: 'land-blocked', verdict })]);
    fixture.detectChanges();
    expect(Array.from(fixture.nativeElement.querySelectorAll('h3'), (node: Element) => node.textContent)
      .filter(text => text === 'Ready to review and merge')).toHaveLength(1);
    const toggles = fixture.nativeElement.querySelectorAll('.pq-parked-section-toggle') as NodeListOf<HTMLButtonElement>;
    expect(toggles[0].textContent).toContain('Ready to review and merge');
    toggles[1].click(); fixture.detectChanges();
    expect(Array.from(fixture.nativeElement.querySelectorAll('.pq-parked-doc'), (node: Element) => node.textContent).at(-1)).toBe('other.md');
  });

  it('explains a reason once for the whole section, not on every job', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'a', sourceRef: 'a.md' }), makeItem({ id: 'b', sourceRef: 'b.md' })]);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text.split('Ran out of all the rounds')).toHaveLength(2);
    expect(fixture.nativeElement.querySelectorAll('.pq-parked-item')).toHaveLength(2);
  });

  it('keeps closed sections out of the page and fetches no diffstats for them', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'big-1', sourceRef: 'a.md' }), makeItem({ id: 'big-2', sourceRef: 'b.md' }),
      makeItem({ id: 'small', sourceRef: 'c.md', parkReason: 'worker-error' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.pq-parked-item')).toHaveLength(2);
    expect(store.diffstat.mock.calls.map(([id]) => id).sort()).toEqual(['big-1', 'big-2']);
    (fixture.nativeElement.querySelectorAll('.pq-parked-section-toggle')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.pq-parked-item')).toHaveLength(3);
    expect(store.diffstat).toHaveBeenCalledWith('small');
  });

  it('shows a long section a page at a time', () => {
    fixture.componentRef.setInput('items', Array.from({ length: 30 }, (_, index) => makeItem({ id: `i${index}`, sourceRef: `d${index}.md` })));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.pq-parked-item')).toHaveLength(25);
    const more = fixture.nativeElement.querySelector('.pq-parked-more') as HTMLButtonElement;
    expect(more.textContent).toContain('5 left');
    more.click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.pq-parked-item')).toHaveLength(30);
    expect(fixture.nativeElement.querySelector('.pq-parked-more')).toBeNull();
  });

  it('runs only a few git checks at once and works through the rest', async () => {
    const replies: ((value: string) => void)[] = [];
    store.diffstat.mockImplementation(() => new Promise<string>((resolve) => replies.push(resolve)));
    fixture.componentRef.setInput('items', Array.from({ length: 6 }, (_, index) => makeItem({ id: `i${index}`, sourceRef: `d${index}.md` })));
    fixture.detectChanges();
    expect(store.diffstat).toHaveBeenCalledTimes(4);
    replies.shift()!('1 file changed');
    await Promise.resolve(); await Promise.resolve();
    expect(store.diffstat).toHaveBeenCalledTimes(5);
  });

  it('never shows a loading diff for a job with no branch', () => {
    fixture.componentRef.setInput('items', [makeItem({ branchName: null })]);
    fixture.detectChanges();
    expect(store.diffstat).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).not.toContain('Loading diff');
  });

  it('searches documents, branches and projects, opening each section with a match', () => {
    fixture.componentRef.setInput('runs', [{ id: 'run-1', workspaceCwd: '/work/alpha', config: {}, items: [] }, { id: 'run-2', workspaceCwd: '/work/beta', config: {}, items: [] }]);
    fixture.componentRef.setInput('items', [makeItem({ id: 'a', sourceRef: 'one.md' }), makeItem({ id: 'b', sourceRef: 'two.md' }),
      makeItem({ id: 'c', runId: 'run-2', sourceRef: 'three.md', parkReason: 'worker-error', branchName: 'queue/three' })]);
    fixture.detectChanges();
    const search = (value: string) => {
      const input = fixture.nativeElement.querySelector('.pq-parked-search') as HTMLInputElement;
      input.value = value; input.dispatchEvent(new Event('input')); fixture.detectChanges();
      return Array.from(fixture.nativeElement.querySelectorAll('.pq-parked-doc'), (node: Element) => node.textContent);
    };
    expect(search('three')).toEqual(['three.md']);
    expect(search('BETA')).toEqual(['three.md']);
    expect(search('queue/three')).toEqual(['three.md']);
    expect(search('nothing-here')).toEqual([]);
    expect(fixture.nativeElement.textContent).toContain('No set-aside work matches “nothing-here”');
  });

  it('previews only the section it was opened from', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'a', sourceRef: 'a.md' }), makeItem({ id: 'b', sourceRef: 'b.md' }),
      makeItem({ id: 'c', sourceRef: 'c.md', parkReason: 'worker-error' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.resumeItems.subscribe(ids => emitted.push(...ids));
    (fixture.nativeElement.querySelectorAll('.pq-bulk-resume')[1] as HTMLButtonElement).click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview').textContent).toContain('Will change (1)');
    fixture.nativeElement.querySelector('.pq-bulk-confirm').click();
    expect(emitted).toEqual(['c']);
  });

  it('resumes exactly the reviewed list, even if a refresh changes the section meanwhile', () => {
    const first = makeItem({ id: 'a', sourceRef: 'a.md' });
    fixture.componentRef.setInput('items', [first, makeItem({ id: 'b', sourceRef: 'b.md' })]);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.pq-bulk-resume').click(); fixture.detectChanges();
    fixture.componentRef.setInput('items', [first, makeItem({ id: 'c', sourceRef: 'c.md' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.resumeItems.subscribe(ids => emitted.push(...ids));
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview').textContent).toContain('Will change (1)');
    fixture.nativeElement.querySelector('.pq-bulk-confirm').click();
    expect(emitted).toEqual(['a']);
  });

  it('keeps a job whose document has since merged out of a bulk preview', () => {
    const merged = makeItem({ id: 'merged', runId: 'run-2', sourceRef: 'a.md', state: 'landed', createdAt: 9 });
    fixture.componentRef.setInput('runs', [{ id: 'run-1', workspaceCwd: '/w', config: {}, items: [] }, { id: 'run-2', workspaceCwd: '/w', config: {}, items: [merged] }]);
    fixture.componentRef.setInput('items', [makeItem({ id: 'a', sourceRef: 'a.md' }), makeItem({ id: 'b', sourceRef: 'b.md' })]);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.pq-bulk-resume').click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview').textContent).not.toContain('a.md');
    expect(fixture.nativeElement.querySelector('.pq-bulk-confirm').textContent).toContain('Resume 1 job');
  });

  it('keeps the open section open when a refresh moves another section above it', () => {
    const verdict = { verdict: 'PASS' as const, findings: [], gatesRun: [], documentComplete: true, needJames: [] };
    const reading = makeItem({ id: 'a', sourceRef: 'a.md' });
    fixture.componentRef.setInput('items', [reading]);
    fixture.detectChanges();
    fixture.componentRef.setInput('items', [reading, makeItem({ id: 'ready', sourceRef: 'b.md', parkReason: 'land-blocked', verdict })]);
    fixture.detectChanges();
    const toggles = fixture.nativeElement.querySelectorAll('.pq-parked-section-toggle') as NodeListOf<HTMLButtonElement>;
    expect(toggles[0].textContent).toContain('Ready to review and merge');
    expect(toggles[0].getAttribute('aria-expanded')).toBe('false');
    expect(toggles[1].getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps a section the user opened open when the default section empties', () => {
    const other = makeItem({ id: 'c', sourceRef: 'c.md', parkReason: 'worker-error' });
    fixture.componentRef.setInput('items', [makeItem({ id: 'a', sourceRef: 'a.md' }), makeItem({ id: 'b', sourceRef: 'b.md' }), other]);
    fixture.detectChanges();
    (fixture.nativeElement.querySelectorAll('.pq-parked-section-toggle')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    fixture.componentRef.setInput('items', [other]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-parked-section-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('opens the next section by default when the open one empties', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'a', sourceRef: 'a.md' }), makeItem({ id: 'b', sourceRef: 'b.md' }),
      makeItem({ id: 'c', sourceRef: 'c.md', parkReason: 'worker-error' })]);
    fixture.detectChanges();
    fixture.componentRef.setInput('items', [makeItem({ id: 'c', sourceRef: 'c.md', parkReason: 'worker-error' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-parked-section-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('closes a preview with its section and returns focus to the section heading', () => {
    fixture.componentRef.setInput('items', [makeItem()]);
    fixture.detectChanges();
    const toggle = fixture.nativeElement.querySelector('.pq-parked-section-toggle') as HTMLButtonElement;
    fixture.nativeElement.querySelector('.pq-bulk-resume').click(); fixture.detectChanges();
    (fixture.nativeElement.querySelector('.pq-bulk-preview-actions button:last-child') as HTMLButtonElement).click(); fixture.detectChanges();
    expect(document.activeElement).toBe(toggle);
    fixture.nativeElement.querySelector('.pq-bulk-resume').click(); fixture.detectChanges();
    toggle.click(); fixture.detectChanges(); toggle.click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview')).toBeNull();
  });

  it('does not restart a reviewed job that has since become busy, and says so in its count', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'a', sourceRef: 'a.md' }), makeItem({ id: 'b', sourceRef: 'b.md' })]);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.pq-bulk-resume').click(); fixture.detectChanges();
    fixture.componentRef.setInput('busyDocuments', ['a.md']); fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.resumeItems.subscribe(ids => emitted.push(...ids));
    const preview = fixture.nativeElement.querySelector('.pq-bulk-preview') as HTMLElement;
    expect(preview.querySelector('.pq-bulk-confirm')?.textContent).toContain('Resume 1 job');
    expect(preview.textContent).toContain('Will change (1)');
    expect(preview.textContent).toContain('a.md: it changed after this preview opened');
    fixture.nativeElement.querySelector('.pq-bulk-confirm').click();
    expect(emitted).toEqual(['b']);
  });

  it('keeps passed work stopped by a merge clash out of a bulk Resume, but on its own Resume button', () => {
    const verdict = { verdict: 'PASS' as const, findings: [], gatesRun: [], documentComplete: true, needJames: [] };
    fixture.componentRef.setInput('items', [makeItem({ parkReason: 'merge-conflict', verdict })]);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.pq-bulk-resume').click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview').textContent).toContain('Will change (0)');
    expect(fixture.nativeElement.querySelector('.pq-bulk-confirm').disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('.pq-resume-item')).not.toBeNull();
  });

  describe('a document that merged in a newer attempt', () => {
    const verdict = { verdict: 'PASS' as const, findings: [], gatesRun: [], documentComplete: true, needJames: [] };
    const merged = makeItem({ id: 'merged', runId: 'run-2', sourceRef: 'a.md', state: 'landed', createdAt: 9 });
    beforeEach(() => {
      fixture.componentRef.setInput('runs', [{ id: 'run-1', workspaceCwd: '/w', config: {}, items: [] }, { id: 'run-2', workspaceCwd: '/w', config: {}, items: [merged] }]);
      fixture.componentRef.setInput('items', [makeItem({ id: 'old', sourceRef: 'a.md', parkReason: 'land-blocked', verdict })]);
      fixture.detectChanges();
    });

    it('moves an old attempt out of Ready and offers neither Try merging again nor Resume', () => {
      expect(fixture.nativeElement.querySelector('.pq-parked-section-toggle').textContent).toContain('A newer attempt already merged');
      expect(fixture.nativeElement.textContent).not.toContain('Ready to review and merge');
      expect(fixture.nativeElement.querySelector('.pq-retry-landing')).toBeNull();
      expect(fixture.nativeElement.querySelector('.pq-resume-item')).toBeNull();
      expect(fixture.nativeElement.querySelector('.pq-bulk-resume')).toBeNull();
      expect(fixture.nativeElement.querySelector('.pq-discard')).not.toBeNull();
    });

    it('warns before merging the old branch on top of the merged work', () => {
      fixture.nativeElement.querySelector('.pq-merge-without-checks').click(); fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.pq-parked-confirm').textContent).toContain('A newer attempt at this document already merged');
    });
  });

  describe('trying all merges again', () => {
    const verdict = { verdict: 'PASS' as const, findings: [], gatesRun: [], documentComplete: true, needJames: [] };
    const ready = (id: string, createdAt: number) => makeItem({ id, sourceRef: `${id}.md`, parkReason: 'land-blocked', verdict, createdAt });

    it('previews first, says what it may cost, and sends the oldest first', () => {
      fixture.componentRef.setInput('items', [ready('newer', 5), ready('older', 2)]);
      fixture.detectChanges();
      const emitted: string[][] = [];
      fixture.componentInstance.retryLandings.subscribe(ids => emitted.push(ids));
      fixture.nativeElement.querySelector('.pq-bulk-retry').click(); fixture.detectChanges();
      expect(emitted).toEqual([]);
      const preview = fixture.nativeElement.querySelector('.pq-bulk-preview') as HTMLElement;
      expect(preview.textContent).toContain('uses provider usage');
      expect(preview.querySelector('.pq-bulk-confirm')?.textContent).toContain('Try merging 2 jobs');
      (preview.querySelector('.pq-bulk-confirm') as HTMLButtonElement).click();
      expect(emitted).toEqual([['older', 'newer']]);
    });

    it('only offers it on work that is ready', () => {
      fixture.componentRef.setInput('items', [makeItem()]);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.pq-bulk-retry')).toBeNull();
    });

    it('leaves out a job that became busy after the preview opened', () => {
      fixture.componentRef.setInput('items', [ready('a', 1), ready('b', 2)]);
      fixture.detectChanges();
      fixture.nativeElement.querySelector('.pq-bulk-retry').click(); fixture.detectChanges();
      fixture.componentRef.setInput('busyDocuments', ['a.md']); fixture.detectChanges();
      const emitted: string[][] = [];
      fixture.componentInstance.retryLandings.subscribe(ids => emitted.push(ids));
      fixture.nativeElement.querySelector('.pq-bulk-confirm').click();
      expect(emitted).toEqual([['b']]);
    });

    it('shows progress with a way to stop, and hides the button meanwhile', () => {
      fixture.componentRef.setInput('items', [ready('a', 1)]);
      fixture.componentRef.setInput('retryProgress', { done: 2, total: 68, stopping: false });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.pq-parked-retrying').textContent).toContain('Merging 3 of 68');
      expect(fixture.nativeElement.querySelector('.pq-bulk-retry')).toBeNull();
      expect(fixture.nativeElement.querySelector('.pq-retry-landing')).toBeNull();
      let stopped = 0;
      fixture.componentInstance.stopRetrying.subscribe(() => stopped++);
      fixture.nativeElement.querySelector('.pq-stop-retrying').click();
      expect(stopped).toBe(1);
    });

    it('says it is stopping and offers a way to stop waiting', () => {
      fixture.componentRef.setInput('items', [ready('a', 1)]);
      fixture.componentRef.setInput('retryProgress', { done: 2, total: 68, stopping: true });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.pq-parked-retrying').textContent).toContain('Stopping after 3 of 68');
      expect(fixture.nativeElement.querySelector('.pq-stop-retrying').textContent).toContain('Stop waiting');
    });

    it('leaves out jobs from a paused run', () => {
      fixture.componentRef.setInput('runs', [{ id: 'run-1', workspaceCwd: '/w', status: 'paused', config: {}, items: [] }]);
      fixture.componentRef.setInput('items', [ready('a', 1)]);
      fixture.detectChanges();
      fixture.nativeElement.querySelector('.pq-bulk-retry').click(); fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.pq-bulk-preview').textContent).toContain('its run is paused');
      expect(fixture.nativeElement.querySelector('.pq-bulk-confirm').disabled).toBe(true);
    });
  });

  it('never offers bulk Resume on work that is ready to merge, because Resume wipes its passed check', () => {
    const verdict = { verdict: 'PASS' as const, findings: [], gatesRun: [], documentComplete: true, needJames: [] };
    fixture.componentRef.setInput('items', [makeItem({ parkReason: 'land-blocked', verdict })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-parked-section-toggle').textContent).toContain('Ready to review and merge');
    expect(fixture.nativeElement.querySelector('.pq-bulk-resume')).toBeNull();
    expect(fixture.nativeElement.querySelector('.pq-resume-item')).not.toBeNull();
  });

  it('drops a preview whose section goes away, so it does not return unasked', () => {
    const item = makeItem();
    fixture.componentRef.setInput('items', [item]);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.pq-bulk-resume').click(); fixture.detectChanges();
    fixture.componentRef.setInput('items', []); fixture.detectChanges();
    fixture.componentRef.setInput('items', [item]); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview')).toBeNull();
  });

  it('stops starting git checks once the list is gone', async () => {
    const replies: ((value: string) => void)[] = [];
    store.diffstat.mockImplementation(() => new Promise<string>((resolve) => replies.push(resolve)));
    fixture.componentRef.setInput('items', Array.from({ length: 6 }, (_, index) => makeItem({ id: `i${index}`, sourceRef: `d${index}.md` })));
    fixture.detectChanges();
    fixture.destroy();
    replies.shift()!('1 file changed');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(store.diffstat).toHaveBeenCalledTimes(4);
  });

  it('closes a bulk preview when the search changes, so it cannot reappear unasked', () => {
    fixture.componentRef.setInput('items', [makeItem()]);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.pq-bulk-resume').click(); fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('.pq-parked-search') as HTMLInputElement;
    for (const value of ['hidden', '']) { input.value = value; input.dispatchEvent(new Event('input')); fixture.detectChanges(); }
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview')).toBeNull();
  });

  it('keeps an opened earlier try visible after its section is closed and reopened', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'new', createdAt: 2 }), makeItem({ id: 'old', updatedAt: 9 })]);
    fixture.detectChanges();
    const details = fixture.nativeElement.querySelector('.pq-earlier-tries') as HTMLDetailsElement;
    details.open = true; details.dispatchEvent(new Event('toggle')); fixture.detectChanges();
    const toggle = fixture.nativeElement.querySelector('.pq-parked-section-toggle') as HTMLButtonElement;
    toggle.click(); fixture.detectChanges(); toggle.click(); fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('.pq-earlier-tries') as HTMLDetailsElement).open).toBe(true);
  });

  it('puts the section heading around its toggle, which names the body it controls', () => {
    fixture.componentRef.setInput('items', [makeItem()]);
    fixture.detectChanges();
    const toggle = fixture.nativeElement.querySelector('h3 .pq-parked-section-toggle') as HTMLButtonElement;
    expect(toggle.textContent?.trim()).toBe('Ran out of rounds');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).not.toBeNull();
  });

  it('names an older attempt that stopped for a different reason, and fetches its diffstat only when opened', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'new', createdAt: 2 }), makeItem({ id: 'old', updatedAt: 9, parkReason: 'worker-error' })]);
    fixture.detectChanges();
    expect(store.diffstat.mock.calls.map(([id]) => id)).toEqual(['new']);
    expect(fixture.nativeElement.querySelectorAll('.pq-parked-item')).toHaveLength(1);
    const details = fixture.nativeElement.querySelector('.pq-earlier-tries') as HTMLDetailsElement;
    details.open = true; details.dispatchEvent(new Event('toggle')); fixture.detectChanges();
    expect(store.diffstat).toHaveBeenCalledWith('old');
    expect(details.textContent).toContain('The worker stopped with an error');
  });

  it('renders the document name, branch name and park reason', () => {
    fixture.componentRef.setInput('items', [makeItem()]);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(fixture.nativeElement.querySelector('.pq-parked-doc')?.textContent).toBe('foo_plan.md');
    expect(text).toContain('plan-queue/foo-plan');
    expect(text).toContain('Ran out of rounds');
  });

  it('fetches and renders the diffstat for each item', async () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'item-a' })]);
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(store.diffstat).toHaveBeenCalledWith('item-a');
    expect(fixture.nativeElement.textContent).toContain('1 file changed, 4 insertions(+)');
  });

  it('resumes immediately without a confirmation step', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'item-a', parkReason: 'worker-error' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.resumeItem.subscribe((id) => emitted.push(id));

    (fixture.nativeElement.querySelector('.pq-resume-item') as HTMLButtonElement).click();

    expect(emitted).toEqual(['item-a']);
  });

  it('requires a confirm click before emitting discardItem', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'item-a' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.discardItem.subscribe((id) => emitted.push(id));

    (fixture.nativeElement.querySelector('.pq-discard') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(emitted).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('keeps that work for 30 days');

    (fixture.nativeElement.querySelector('.pq-confirm-yes') as HTMLButtonElement).click();
    expect(emitted).toEqual(['item-a']);
  });

  it('requires a confirm click before emitting landAnyway', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'item-a' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.landAnyway.subscribe((id) => emitted.push(id));

    (fixture.nativeElement.querySelector('.pq-merge-without-checks') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(emitted).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('never passed verification');

    (fixture.nativeElement.querySelector('.pq-confirm-yes') as HTMLButtonElement).click();
    expect(emitted).toEqual(['item-a']);
  });

  it('lets James back out of a discard confirmation', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'item-a' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.discardItem.subscribe((id) => emitted.push(id));

    (fixture.nativeElement.querySelector('.pq-discard') as HTMLButtonElement).click();
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('.pq-parked-confirm button');
    (buttons[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(emitted).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('.pq-parked-actions')).toBeTruthy();
  });
  it('shows a land-blocked PASS detail sentence and Try merging again without new worker rounds', () => {
    fixture.componentRef.setInput('items', [makeItem({
      parkReason: 'land-blocked',
      detail: "Couldn't merge: you have uncommitted changes to docs/shared.md in your main checkout. Commit or set them aside, then Try merging again.",
      verdict: { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: true, needJames: [] },
    })]); fixture.detectChanges();
    const emitted: string[] = []; fixture.componentInstance.retryLanding.subscribe(id => emitted.push(id));
    expect(fixture.nativeElement.textContent).toContain('uncommitted changes to docs/shared.md');
    fixture.nativeElement.querySelector('.pq-retry-landing').click(); expect(emitted).toEqual(['item-1']);
  });
  it('Land anyway on a PASSed item says it passed verification', () => {
    fixture.componentRef.setInput('items', [makeItem({ parkReason: 'land-blocked',
      verdict: { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: true, needJames: [] },
    })]); fixture.detectChanges();
    fixture.componentInstance.requestConfirm('item-1', 'land-anyway'); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('It passed verification, but its last merge was blocked.');
    expect(fixture.nativeElement.textContent).not.toContain('never passed verification');
  });
  it.each([['land-blocked', 'FAIL'], ['round-limit', 'PASS'], ['merge-conflict', 'PASS']] as const)(
    'offers no merge retry for %s with %s', (parkReason, verdict) => {
      fixture.componentRef.setInput('items', [makeItem({ parkReason,
        verdict: { verdict, findings: [], gatesRun: [], documentComplete: true, needJames: [] },
      })]); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('.pq-retry-landing')).toBeNull();
    },
  );

  it('groups older attempts and folds long details with absolute paths removed', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'old' }), makeItem({ id: 'new', createdAt: 2,
      detail: '/Users/example/private/report.txt ' + 'saved evidence '.repeat(250) })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-parked-item .pq-parked-detail').textContent).not.toContain('/Users/');
    expect(fixture.nativeElement.querySelector('.pq-parked-detail').open).toBe(false);
    expect(fixture.nativeElement.querySelector('.pq-earlier-tries summary').textContent).toContain('1 earlier try');
    expect(fixture.nativeElement.querySelector('.pq-earlier-tries').open).toBe(false);
  });

  it('requires the bulk preview before resuming and exposes no bulk merge or discard', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'first', sourceRef: 'a.md' }), makeItem({ id: 'second', sourceRef: 'b.md' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.resumeItems.subscribe(ids => emitted.push(...ids));
    fixture.nativeElement.querySelector('.pq-bulk-resume').click(); fixture.detectChanges();
    expect(emitted).toEqual([]);
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview').textContent).toContain('Will change (2)');
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview').textContent).toContain('Left alone (0)');
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview').textContent).not.toContain('Discard');
    fixture.nativeElement.querySelector('.pq-bulk-confirm').click();
    expect(emitted).toEqual(['first', 'second']);
  });

  it('keeps Resume and Discard available for older work with no recorded reason', () => {
    fixture.componentRef.setInput('items', [makeItem({ parkReason: null })]); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-resume-item')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.pq-discard')).not.toBeNull();
  });

  it('shows the checker findings in a bulk-resume preview before confirmation', () => {
    fixture.componentRef.setInput('items', [makeItem({ verdict: { verdict: 'FAIL', documentComplete: false,
      findings: [{ severity: 'high', confidence: 95, summary: 'The saved retry is never resumed.' }], gatesRun: [], needJames: [] } })]);
    fixture.detectChanges(); fixture.nativeElement.querySelector('.pq-bulk-resume').click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview').textContent).toContain('The saved retry is never resumed.');
  });

});
