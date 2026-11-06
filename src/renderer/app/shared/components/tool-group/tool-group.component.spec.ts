/**
 * Unit tests for ToolGroupComponent.
 *
 * The collapsed header keeps two things only: the expand control and a count of
 * failed calls. What the turn did overall ("edited 2 files · ran 3 commands")
 * is written once, under the turn, by the turn note, so this header no longer
 * repeats it as "44 calls · 900,532 characters · 25 results externalized".
 *
 * "Failed" follows the shared definition (src/shared/turn-tool-events.ts): an
 * edit or write that errored, or a command that could not run or that the
 * provider marked as a check and that exited non-zero. A search that finds
 * nothing exits non-zero and is not a failure.
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToolGroupComponent } from './tool-group.component';
import type { OutputMessage } from '../../../core/state/instance.store';

let sequence = 0;

function toolUse(metadata: Record<string, unknown>, timestamp = 1_000 + sequence): OutputMessage {
  sequence += 1;
  return { id: `use-${sequence}`, timestamp, type: 'tool_use', content: '', metadata };
}

function toolResult(metadata: Record<string, unknown>, content = '', timestamp = 1_000 + sequence): OutputMessage {
  sequence += 1;
  return { id: `result-${sequence}`, timestamp, type: 'tool_result', content, metadata };
}

describe('ToolGroupComponent', () => {
  let fixture: ComponentFixture<ToolGroupComponent>;
  let host: HTMLElement;

  async function render(messages: OutputMessage[], itemId = 'item-1'): Promise<void> {
    fixture.componentRef.setInput('toolMessages', messages);
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('itemId', itemId);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const header = (): HTMLButtonElement => host.querySelector('button.tool-group-header') as HTMLButtonElement;
  const failureBadge = (): HTMLElement | null => host.querySelector('.tool-failed');

  beforeEach(async () => {
    sequence = 0;
    await TestBed.configureTestingModule({ imports: [ToolGroupComponent] }).compileComponents();
    fixture = TestBed.createComponent(ToolGroupComponent);
    host = fixture.nativeElement as HTMLElement;
  });

  it('no longer repeats the turn summary as calls, characters and externalized results', async () => {
    const messages: OutputMessage[] = [];
    for (let i = 0; i < 44; i++) {
      messages.push(toolUse({ name: 'Bash', id: `c${i}`, input: { command: 'ls' } }));
      messages.push(toolResult({ name: 'Bash', id: `c${i}`, exitCode: 0, externalized: i < 25 }, 'x'.repeat(20_467)));
    }
    await render(messages);

    const text = header().textContent ?? '';
    expect(text).not.toMatch(/\d+ calls?|characters|externalized|\d{1,3},\d{3}/i);
    expect(header().getAttribute('aria-label')).toBe('Tool calls');
  });

  it('shows the expand control and no failure count when nothing failed', async () => {
    await render([
      toolUse({ name: 'Read', id: 'r1', input: { file_path: 'a.ts' } }),
      toolResult({ name: 'Read', id: 'r1', is_error: false }, 'contents'),
    ]);

    expect(header()).toBeTruthy();
    expect(failureBadge()).toBeNull();
    expect(header().getAttribute('aria-label')).toBe('Tool calls');
    expect(header().getAttribute('aria-expanded')).toBe('false');
  });

  it('shows how many calls failed', async () => {
    await render([
      toolUse({ name: 'Edit', id: 'e1', input: { file_path: 'a.ts' } }),
      toolResult({ name: 'Edit', id: 'e1', status: 'failed', is_error: true }, 'File change failed: a.ts'),
      toolUse({ name: 'Bash', id: 'b1', input: { command: 'make' } }),
      toolResult({ name: 'Bash', id: 'b1', status: 'failed', is_error: true }),
      toolUse({ name: 'Write', id: 'w1', input: { file_path: 'ok.ts' } }),
      toolResult({ name: 'Write', id: 'w1', is_error: false }),
    ]);

    expect(failureBadge()?.textContent?.trim()).toBe('2 failed');
    expect(header().getAttribute('aria-label')).toBe('Tool calls, 2 failed');
  });

  it('does not count a search that found nothing, or a read that errored', async () => {
    await render([
      toolUse({ id: 'b1', name: 'Bash', input: { command: 'rg nothing src' }, phase: 'running' }),
      toolResult({ id: 'b1', name: 'Bash', status: 'completed', exitCode: 1, is_error: true }),
      toolUse({ name: 'Read', id: 'r1', input: { file_path: 'gone.ts' } }),
      toolResult({ name: 'Read', id: 'r1', is_error: true }, 'File does not exist'),
    ]);

    expect(failureBadge()).toBeNull();
  });

  it('counts a command the provider marked as a check when it exits non-zero', async () => {
    await render([
      toolUse({ id: 'b1', name: 'Bash', input: { command: 'npm test' }, phase: 'verifying' }),
      toolResult({ id: 'b1', name: 'Bash', status: 'completed', exitCode: 1, is_error: true }),
    ]);

    expect(failureBadge()?.textContent?.trim()).toBe('1 failed');
  });

  it('keeps the failure count current as calls arrive', async () => {
    const messages = [
      toolUse({ name: 'Edit', id: 'e1', input: { file_path: 'a.ts' } }),
    ];
    await render(messages);
    expect(failureBadge()).toBeNull();

    await render([...messages, toolResult({ name: 'Edit', id: 'e1', is_error: true }, 'denied')]);
    expect(failureBadge()?.textContent?.trim()).toBe('1 failed');
  });

  it('does not show a time range in the header', async () => {
    await render([
      toolUse({ name: 'Bash', id: 'b1' }, Date.UTC(2026, 9, 20, 10, 0, 0)),
      toolResult({ name: 'Bash', id: 'b1', exitCode: 0 }, '', Date.UTC(2026, 9, 20, 10, 5, 0)),
    ]);

    expect(host.querySelector('.tool-time')).toBeNull();
    expect(header().textContent).not.toMatch(/\d{2}:\d{2}/);
  });

  it('opens and closes, and the control reflects the state', async () => {
    await render([
      toolUse({ name: 'Bash', id: 'b1', input: { command: 'ls' } }),
      toolResult({ name: 'Bash', id: 'b1', exitCode: 0 }, 'files'),
    ]);

    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.tool-group-content')).toBeNull();

    header().click();
    fixture.detectChanges();
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.tool-group-content')).toBeTruthy();
    expect(host.querySelectorAll('.tool-item')).toHaveLength(2);

    header().click();
    fixture.detectChanges();
    expect(header().getAttribute('aria-expanded')).toBe('false');
  });

  it('adds no native title attribute', async () => {
    await render([toolUse({ name: 'Bash', id: 'b1' }), toolResult({ name: 'Bash', id: 'b1', status: 'failed' })]);
    expect(host.querySelector('[title]')).toBeNull();
  });
});
