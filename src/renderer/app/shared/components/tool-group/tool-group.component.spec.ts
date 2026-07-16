/**
 * Unit tests for ToolGroupComponent.
 *
 * Covers:
 * - Truthful collapsed summary counting (actual tool_use calls / tool_result
 *   characters, not the combined renderer message-wrapper count).
 * - Omitting the "results externalized" segment when no message carries that
 *   metadata, vs. showing a real count when it does.
 * - Basic accessibility on the collapsible header button.
 *
 * The Angular compiler plugin is absent from the vitest config so signal
 * input wiring via `fixture.componentRef.setInput()` is unreliable for
 * `input()`/`input.required()` fields; this repo's established workaround
 * (see checkpoint-timeline.component.spec.ts) is to override the signal
 * getter directly on the instance before `detectChanges()`.
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToolGroupComponent } from './tool-group.component';
import { ExpansionStateService } from '../../../features/instance-detail/expansion-state.service';
import type { OutputMessage } from '../../../core/state/instance.store';

function toolUse(id: string, timestamp: number, name = 'Bash'): OutputMessage {
  return {
    id,
    timestamp,
    type: 'tool_use',
    content: '',
    metadata: { name },
  };
}

function toolResult(
  id: string,
  timestamp: number,
  content: string,
  metadata?: Record<string, unknown>,
): OutputMessage {
  return { id, timestamp, type: 'tool_result', content, metadata };
}

function setMessages(component: ToolGroupComponent, messages: OutputMessage[]): void {
  (component as unknown as { toolMessages: () => OutputMessage[] }).toolMessages = () => messages;
}

function setGroupKey(component: ToolGroupComponent, instanceId: string, itemId: string): void {
  (component as unknown as { instanceId: () => string }).instanceId = () => instanceId;
  (component as unknown as { itemId: () => string }).itemId = () => itemId;
}

describe('ToolGroupComponent', () => {
  let fixture: ComponentFixture<ToolGroupComponent>;
  let component: ToolGroupComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ToolGroupComponent],
      providers: [ExpansionStateService],
    }).compileComponents();

    fixture = TestBed.createComponent(ToolGroupComponent);
    component = fixture.componentInstance;
    setGroupKey(component, 'inst-1', 'item-1');
  });

  it('counts real tool_use calls, not the combined message-wrapper count', () => {
    setMessages(component, [
      toolUse('1', 1),
      toolResult('2', 2, 'a'.repeat(10)),
      toolUse('3', 3),
      toolResult('4', 4, 'b'.repeat(5)),
    ]);
    fixture.detectChanges();

    expect(component.toolCallCount()).toBe(2);
    expect(component.resultCharacterCount()).toBe(15);
  });

  it('omits the externalized segment when no message reports it', () => {
    setMessages(component, [toolUse('1', 1), toolResult('2', 2, 'x'.repeat(500))]);
    fixture.detectChanges();

    expect(component.externalizedResultCount()).toBeNull();
    expect(component.summaryLabel()).not.toContain('externalized');
  });

  it('shows a truthful summary matching the documented example shape', () => {
    const messages: OutputMessage[] = [];
    for (let i = 0; i < 44; i++) {
      messages.push(toolUse(`call-${i}`, i));
      messages.push(toolResult(`result-${i}`, i, 'x'.repeat(20_467), { externalized: i < 25 }));
    }
    setMessages(component, messages);
    fixture.detectChanges();

    expect(component.toolCallCount()).toBe(44);
    expect(component.resultCharacterCount()).toBe(44 * 20_467);
    expect(component.externalizedResultCount()).toBe(25);
    expect(component.summaryLabel()).toBe(
      `44 calls · ${(44 * 20_467).toLocaleString('en-US')} characters · 25 results externalized`,
    );
  });

  it('counts only messages explicitly flagged true when some report false', () => {
    setMessages(component, [
      toolResult('1', 1, 'a', { externalized: true }),
      toolResult('2', 2, 'b', { externalized: false }),
      toolResult('3', 3, 'c', { externalized: false }),
    ]);
    fixture.detectChanges();

    expect(component.externalizedResultCount()).toBe(1);
    expect(component.summaryLabel()).toContain('1 result externalized');
  });

  it('exposes an accessible, labeled toggle button reflecting expanded state', () => {
    setMessages(component, [toolUse('1', 1), toolResult('2', 2, 'abc')]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const button = host.querySelector('button.tool-group-header') as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe(component.summaryLabel());

    button.click();
    fixture.detectChanges();

    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.tool-group-content')).toBeTruthy();
  });
});
