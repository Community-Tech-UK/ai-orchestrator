import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueLinearPreview, PlanQueueLinearPreviewRow, PlanQueueLinearPreviewText, PlanQueueRouting } from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService } from '../../../core/services/ipc/plan-queue-ipc.service';
import { SettingsStore } from '../../../core/state/settings.store';
import { PlanQueueLinearStartPreviewComponent } from './plan-queue-linear-start-preview.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-linear-start-preview.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-linear-start-preview.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-linear-start-preview.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-linear-start-preview.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const HOSTILE = '<img src="https://example.test/x.png"> and <script>window.hacked = true</script>\nsecond line';

function row(overrides: Partial<PlanQueueLinearPreviewRow> & { id: string; identifier: string }): PlanQueueLinearPreviewRow {
  return {
    title: 'A ticket', priority: 3, assigneeName: null, labels: [], teamId: 'team-orc', projectId: 'project-orc',
    ticked: false, canTick: true, waitingFor: [], reason: null, notes: [], ...overrides,
  };
}

function makePreview(rows: PlanQueueLinearPreviewRow[], overrides: Partial<PlanQueueLinearPreview> = {}): PlanQueueLinearPreview {
  return {
    previewId: 'preview-1', loadedAt: 1, expiresAt: 2, folder: '/repo', labelNote: null, rows,
    projects: [{
      projectId: 'project-orc', projectName: 'Orchestrator', teamId: 'team-orc', teamKey: 'ORC', ownership: 'own', ready: true, reasons: [],
      allowedProviders: [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }],
    }],
    ...overrides,
  };
}

function textOf(id: string, overrides: Partial<PlanQueueLinearPreviewText> = {}): PlanQueueLinearPreviewText {
  return {
    linearId: id, identifier: 'ORC-1', title: 'A ticket', description: 'Plain description', comments: [], hash: 'a'.repeat(64), overLimit: false,
    ...overrides,
  };
}

describe('PlanQueueLinearStartPreviewComponent', () => {
  let fixture: ComponentFixture<PlanQueueLinearStartPreviewComponent>;
  const linearPreviewLoad = vi.fn();
  const linearPreviewText = vi.fn();
  const linearStart = vi.fn();
  const routing = signal<PlanQueueRouting>({ workers: [], verifiers: [] });

  async function settle(): Promise<void> {
    for (let pass = 0; pass < 4; pass++) {
      await fixture.whenStable();
      fixture.detectChanges();
    }
  }

  async function create(rows: PlanQueueLinearPreviewRow[], overrides: Partial<PlanQueueLinearPreview> = {}): Promise<void> {
    linearPreviewLoad.mockResolvedValue({ success: true, data: makePreview(rows, overrides) });
    linearPreviewText.mockImplementation(async (_previewId: string, id: string) => ({ success: true, data: textOf(id) }));
    fixture = TestBed.createComponent(PlanQueueLinearStartPreviewComponent);
    fixture.componentRef.setInput('parentInstanceId', 'session-1');
    fixture.componentRef.setInput('folder', '/repo');
    fixture.componentRef.setInput('startingProvider', 'claude');
    fixture.detectChanges();
    await settle();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const text = (): string => el().textContent ?? '';
  const boxes = (): HTMLInputElement[] => Array.from(el().querySelectorAll<HTMLInputElement>('input.pq-linear-tick'));
  const buttonNamed = (label: string): HTMLButtonElement | undefined =>
    Array.from(el().querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim().startsWith(label));
  const startButton = (): HTMLButtonElement => el().querySelector<HTMLButtonElement>('button.pq-linear-start')!;

  async function tick(index: number): Promise<void> {
    const box = boxes()[index];
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await settle();
  }

  beforeEach(() => {
    linearPreviewLoad.mockReset();
    linearPreviewText.mockReset();
    linearStart.mockReset();
    routing.set({ workers: [], verifiers: [] });
    TestBed.configureTestingModule({
      imports: [PlanQueueLinearStartPreviewComponent],
      providers: [
        { provide: PlanQueueIpcService, useValue: { linearPreviewLoad, linearPreviewText, linearStart } },
        { provide: SettingsStore, useValue: { settings: signal({}) } },
      ],
    });
    // The component reads the saved routing from the settings store.
    TestBed.overrideProvider(SettingsStore, { useValue: { settings: () => ({ planQueueRouting: routing() }) } });
  });

  it('lists the tickets in the order returned, with priority in words, assignee, ticks and the reason a box is off', async () => {
    await create([
      row({ id: 'l-1', identifier: 'ORC-1', title: 'First', priority: 1, assigneeName: 'Raf', ticked: true, notes: ['Starts after ORC-11'] }),
      row({ id: 'l-2', identifier: 'ORC-2', title: 'Second', priority: 4 }),
      row({ id: 'l-3', identifier: 'ORC-3', title: 'Third', priority: 0, canTick: false, reason: 'Waiting for COM-123', waitingFor: ['COM-123'] }),
    ]);
    const lines = Array.from(el().querySelectorAll('.pq-linear-row')).map((item) => item.textContent ?? '');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('ORC-1');
    expect(lines[0]).toContain('Urgent');
    expect(lines[0]).toContain('Raf');
    expect(lines[0]).toContain('Starts after ORC-11');
    expect(lines[1]).toContain('Low');
    expect(lines[1]).toContain('Unassigned');
    expect(lines[2]).toContain('No priority');
    expect(lines[2]).toContain('Waiting for COM-123');
    expect(boxes().map((box) => box.checked)).toEqual([true, false, false]);
    expect(boxes()[2].getAttribute('aria-disabled')).toBe('true');
    expect(el().querySelector('#pq-linear-reason-l-3')?.textContent).toContain('Waiting for COM-123');
  });

  it('shows one sentence and a link to the Linear settings, with no list, when the folder has no usable link', async () => {
    linearPreviewLoad.mockResolvedValue({ success: false, error: { message: 'No Linear project is linked to this folder. Link one on the Plan Queue page.' } });
    fixture = TestBed.createComponent(PlanQueueLinearStartPreviewComponent);
    fixture.componentRef.setInput('parentInstanceId', 'session-1');
    fixture.componentRef.setInput('folder', '/repo');
    fixture.detectChanges();
    await settle();
    expect(text()).toContain('No Linear project is linked to this folder.');
    expect(el().querySelector('.pq-linear-rows')).toBeNull();
    expect(el().querySelector('.pq-linear-start')).toBeNull();
    const emitted: unknown[] = [];
    fixture.componentInstance.openLinearSetup.subscribe(() => emitted.push(true));
    buttonNamed('Go to the Linear settings')!.click();
    expect(emitted).toHaveLength(1);
  });

  it('shows the team problem instead of a list when no linked team is ready', async () => {
    await create([row({ id: 'l-1', identifier: 'ORC-1' })], {
      projects: [{ projectId: 'project-orc', projectName: 'Orchestrator', teamId: 'team-orc', teamKey: 'ORC', ownership: null, ready: false,
        reasons: ['Save the rules for this team first.'], allowedProviders: [] }],
    });
    expect(text()).toContain('ORC: Save the rules for this team first.');
    expect(el().querySelector('.pq-linear-rows')).toBeNull();
    expect(buttonNamed('Go to the Linear settings')).toBeDefined();
  });

  it('keeps a disabled row unticked whether it is clicked or changed from the keyboard, and says why', async () => {
    await create([row({ id: 'l-1', identifier: 'ORC-1', canTick: false, reason: 'Waiting for COM-123' })]);
    const box = boxes()[0];
    box.click();
    await settle();
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await settle();
    expect(box.checked).toBe(false);
    expect(linearPreviewText).not.toHaveBeenCalled();
    expect(startButton().getAttribute('aria-disabled')).toBe('true');
    expect(text()).toContain('Tick at least one ticket.');
  });

  it('shows a ticket\'s description and comments as plain text, with no image or script element', async () => {
    await create([row({ id: 'l-1', identifier: 'ORC-1' })]);
    linearPreviewText.mockImplementation(async (_previewId: string, id: string) => ({
      success: true,
      data: textOf(id, {
        description: HOSTILE,
        comments: [
          { id: 'c-1', authorName: 'Raf', body: HOSTILE, createdAt: '2026-11-16T10:00:00Z', updatedAt: '2026-11-16T10:00:00Z', fromBot: false },
          { id: 'c-2', authorName: null, body: 'from a bot', createdAt: '2026-11-16T11:00:00Z', updatedAt: '2026-11-16T11:00:00Z', fromBot: true },
        ],
      }),
    }));
    buttonNamed('Read ORC-1')!.click();
    await settle();
    const plain = Array.from(el().querySelectorAll('.pq-linear-plain'));
    expect(plain).toHaveLength(3);
    expect(plain[0].textContent).toBe(HOSTILE);
    expect(plain[1].textContent).toBe(HOSTILE);
    expect(el().querySelector('img')).toBeNull();
    expect(el().querySelector('script')).toBeNull();
    expect(el().querySelector('a')).toBeNull();
    expect(text()).toContain('Only you see this. No AI has read it.');
    expect(text()).toContain('Raf');
    expect(text()).toContain('Unknown author');
    expect(text()).toContain('Written by an integration.');
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it('ticking a row loads and opens its text, and Start waits until every ticked text has loaded', async () => {
    await create([row({ id: 'l-1', identifier: 'ORC-1' })]);
    let finish!: (value: unknown) => void;
    linearPreviewText.mockImplementation(() => new Promise((done) => { finish = done; }));
    await tick(0);
    expect(linearPreviewText).toHaveBeenCalledWith('preview-1', 'l-1');
    expect(el().querySelector('#pq-linear-text-l-1')).not.toBeNull();
    expect(text()).toContain('Loading ORC-1');
    expect(startButton().getAttribute('aria-disabled')).toBe('true');
    startButton().click();
    await settle();
    expect(linearStart).not.toHaveBeenCalled();
    finish({ success: true, data: textOf('l-1') });
    await settle();
    expect(startButton().getAttribute('aria-disabled')).toBeNull();
  });

  it('opens and loads the text of a ticket that arrives ticked before Start can be pressed', async () => {
    await create([row({ id: 'l-1', identifier: 'ORC-1', ticked: true })]);
    expect(linearPreviewText).toHaveBeenCalledWith('preview-1', 'l-1');
    expect(text()).toContain('Plain description');
    expect(startButton().getAttribute('aria-disabled')).toBeNull();
  });

  it('keeps Start off, with the reason in words, when a ticked ticket could not be read', async () => {
    await create([row({ id: 'l-1', identifier: 'ORC-1' })]);
    linearPreviewText.mockResolvedValue({ success: false, error: { message: 'Linear did not answer.' } });
    await tick(0);
    expect(text()).toContain('Linear did not answer.');
    expect(text()).toContain('A ticked ticket could not be read.');
    expect(startButton().getAttribute('aria-disabled')).toBe('true');
  });

  it('flags a ticket whose brief is over the limit', async () => {
    await create([row({ id: 'l-1', identifier: 'ORC-1' })]);
    linearPreviewText.mockResolvedValue({ success: true, data: textOf('l-1', { overLimit: true }) });
    await tick(0);
    expect(text()).toContain('This ticket is long. The worker gets the first 12,000 characters and the full text in a file.');
  });

  it('says which providers will see the ticked text, and names a run provider that is not allowed', async () => {
    routing.set({ workers: [{ provider: 'copilot' }], verifiers: [] });
    await create([row({ id: 'l-1', identifier: 'ORC-1' })]);
    expect(text()).not.toContain('Sessions on these providers');
    await tick(0);
    expect(text()).toContain("Sessions on these providers will be sent the ticked tickets' text: Claude, Codex");
    expect(text()).toMatch(/copilot is not allowed to see tickets from ORC/i);
    expect(startButton().getAttribute('aria-disabled')).toBe('true');
    startButton().click();
    await settle();
    expect(linearStart).not.toHaveBeenCalled();
  });

  it('starts with only the session, the preview id and the ticked ids, and says what was already in a run', async () => {
    await create([row({ id: 'l-1', identifier: 'ORC-1' }), row({ id: 'l-2', identifier: 'ORC-2' })]);
    linearStart.mockResolvedValue({ success: true, data: { run: { id: 'run-1' }, excluded: ['ORC-2'] } });
    await tick(0);
    await tick(1);
    startButton().click();
    await settle();
    expect(linearStart).toHaveBeenCalledTimes(1);
    expect(linearStart.mock.calls[0][0]).toEqual({ parentInstanceId: 'session-1', previewId: 'preview-1', linearIds: ['l-1', 'l-2'] });
    expect(text()).toContain('Started a run with 1 ticket.');
    expect(text()).toContain('Already in a run: ORC-2.');
    expect(el().querySelector('.pq-linear-rows')).toBeNull();
  });

  it('shows a refusal in the main process\'s own words and keeps the ticks', async () => {
    await create([row({ id: 'l-1', identifier: 'ORC-1' })]);
    linearStart.mockResolvedValue({ success: false, error: { message: 'This list is out of date. Load it again.' } });
    await tick(0);
    startButton().click();
    await settle();
    expect(text()).toContain('This list is out of date. Load it again.');
    expect(boxes()[0].checked).toBe(true);
  });

  it('loads the list again on Reload and says the ticks were cleared', async () => {
    await create([row({ id: 'l-1', identifier: 'ORC-1' })]);
    await tick(0);
    buttonNamed('Reload')!.click();
    await settle();
    expect(linearPreviewLoad).toHaveBeenCalledTimes(2);
    expect(boxes()[0].checked).toBe(false);
    expect(text()).toContain('The list was loaded again, so your ticks were cleared.');
  });

  it('says that sessions can still use the Linear tools under Start', async () => {
    await create([row({ id: 'l-1', identifier: 'ORC-1' })]);
    expect(text()).toContain('Sessions in a Linear run can still use your Linear tools.');
  });

  it('uses no raw status words or internal names in what it shows', async () => {
    await create([row({ id: 'l-1', identifier: 'ORC-1', ticked: true })]);
    expect(text()).not.toMatch(/MCP|AIO|Orchestrator|undefined|null/);
  });
});
