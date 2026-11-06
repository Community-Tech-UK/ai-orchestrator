/**
 * SystemEventGroupComponent: the collapsed "N system events" row.
 *
 * The Angular compiler plugin is absent from the vitest config, so signal input
 * wiring through `fixture.componentRef.setInput()` is unreliable for
 * `input.required()` fields. This repo's established workaround (see
 * tool-group.component.spec.ts) is to override the signal getter on the instance
 * before the first `detectChanges()`.
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { SystemEventGroupComponent } from './system-event-group.component';
import { ExpansionStateService } from '../../../features/instance-detail/expansion-state.service';
import { DisplayItemProcessor } from '../../../features/instance-detail/display-item-processor.service';
import type { OutputMessage } from '../../../core/state/instance/instance.types';

function notice(id: string, content: string, timestamp: number, metadata?: Record<string, unknown>): OutputMessage {
  return { id, type: 'system', content, timestamp, ...(metadata ? { metadata } : {}) };
}

function routine(id: string, content: string, timestamp: number, extra: Record<string, unknown> = {}): OutputMessage {
  return notice(id, content, timestamp, { audience: 'routine', ...extra });
}

function setInputs(
  component: SystemEventGroupComponent,
  inputs: { events: OutputMessage[]; label: string; preview: string },
): void {
  const target = component as unknown as Record<string, () => unknown>;
  target['events'] = () => inputs.events;
  target['label'] = () => inputs.label;
  target['preview'] = () => inputs.preview;
  target['instanceId'] = () => 'inst-1';
  target['itemId'] = () => 'sysgrp-test';
}

describe('SystemEventGroupComponent', () => {
  let fixture: ComponentFixture<SystemEventGroupComponent>;
  let component: SystemEventGroupComponent;
  let host: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SystemEventGroupComponent],
      providers: [ExpansionStateService],
    }).compileComponents();

    fixture = TestBed.createComponent(SystemEventGroupComponent);
    component = fixture.componentInstance;
    host = fixture.nativeElement as HTMLElement;
  });

  function header(): HTMLButtonElement {
    return host.querySelector('button.seg-header') as HTMLButtonElement;
  }

  it('shows a routine fold as "N system events" without a second count', () => {
    setInputs(component, {
      events: [routine('r1', 'Interrupted — waiting for input', 1_000), routine('r2', 'Interrupted — waiting for input', 2_000)],
      label: '2 system events',
      preview: 'Interrupted — waiting for input',
    });
    fixture.detectChanges();

    expect(host.querySelector('.seg-label')?.textContent?.trim()).toBe('2 system events');
    expect(host.querySelector('.seg-count')).toBeNull();
    expect(host.querySelector('.seg-preview')?.textContent).toContain('Interrupted — waiting for input');
  });

  it('says "1 system event" for a lone routine notice', () => {
    setInputs(component, {
      events: [routine('r1', 'Interrupted — waiting for input', 1_000)],
      label: '1 system event',
      preview: 'Interrupted — waiting for input',
    });
    fixture.detectChanges();

    expect(host.querySelector('.seg-label')?.textContent?.trim()).toBe('1 system event');
  });

  it('starts collapsed and expands on click to list every event', () => {
    setInputs(component, {
      events: [routine('r1', 'First notice', 1_000), routine('r2', 'Second notice', 2_000)],
      label: '2 system events',
      preview: 'Second notice',
    });
    fixture.detectChanges();

    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.seg-content')).toBeNull();

    header().click();
    fixture.detectChanges();

    expect(header().getAttribute('aria-expanded')).toBe('true');
    const bodies = Array.from(host.querySelectorAll('.seg-event-body')).map((el) => el.textContent?.trim());
    expect(bodies).toEqual(['First notice', 'Second notice']);
  });

  it('shows no severity marker when every event is plain information', () => {
    setInputs(component, {
      events: [routine('r1', 'One', 1_000), routine('r2', 'Two', 2_000)],
      label: '2 system events',
      preview: 'Two',
    });
    fixture.detectChanges();

    expect(host.querySelector('.seg-severity')).toBeNull();
    expect(host.querySelector('.system-event-group')?.getAttribute('data-severity')).toBe('info');
  });

  it('shows the worst severity in the group', () => {
    setInputs(component, {
      events: [
        routine('r1', 'One', 1_000),
        routine('r2', 'Resume failed', 2_000, { severity: 'warning' }),
        routine('r3', 'Three', 3_000),
      ],
      label: '3 system events',
      preview: 'Three',
    });
    fixture.detectChanges();

    expect(host.querySelector('.seg-severity')?.textContent?.trim()).toBe('Warning');
    expect(host.querySelector('.system-event-group')?.getAttribute('data-severity')).toBe('warning');
  });

  it('lets an error outrank a warning', () => {
    setInputs(component, {
      events: [
        routine('r1', 'Warned', 1_000, { severity: 'warning' }),
        routine('r2', 'Failed', 2_000, { severity: 'error' }),
        routine('r3', 'Warned again', 3_000, { severity: 'warning' }),
      ],
      label: '3 system events',
      preview: 'Warned again',
    });
    fixture.detectChanges();

    expect(host.querySelector('.seg-severity')?.textContent?.trim()).toBe('Error');
  });

  it('keeps an orchestration group looking as it did: its own label and an "(Nx)" count', () => {
    setInputs(component, {
      events: [
        notice('g1', 'Active children: a idle', 1_000, { source: 'orchestration', action: 'get_children' }),
        notice('g2', 'Active children: a busy', 2_000, { source: 'orchestration', action: 'get_children' }),
      ],
      label: 'Active children polled',
      preview: 'Active children: a busy',
    });
    fixture.detectChanges();

    expect(host.querySelector('.seg-label')?.textContent?.trim()).toBe('Active children polled');
    expect(host.querySelector('.seg-count')?.textContent?.trim()).toBe('(2x)');
    expect(host.querySelector('.seg-severity')).toBeNull();
  });

  it('renders the row the processor builds for a Stop followed by a failed resume', () => {
    // Exactly the bindings output-stream.component.html passes to this component.
    const [group] = new DisplayItemProcessor().process([
      routine('r1', 'Interrupted — waiting for input', 1_000, { interruptStatus: 'interrupted' }),
      routine('r2', 'Interrupted — session restarted (resume failed)', 2_000, { severity: 'warning' }),
    ]);
    expect(group.type).toBe('system-event-group');

    setInputs(component, { events: group.systemEvents!, label: group.groupLabel!, preview: group.groupPreview! });
    fixture.detectChanges();

    expect(host.querySelector('.seg-label')?.textContent?.trim()).toBe('2 system events');
    expect(host.querySelector('.seg-severity')?.textContent?.trim()).toBe('Warning');
    expect(host.querySelector('.seg-preview')?.textContent).toContain('session restarted (resume failed)');

    header().click();
    fixture.detectChanges();
    expect(Array.from(host.querySelectorAll('.seg-event-body')).map((el) => el.textContent?.trim())).toEqual([
      'Interrupted — waiting for input',
      'Interrupted — session restarted (resume failed)',
    ]);
    expect(host.querySelectorAll('.seg-event[data-severity="warning"]')).toHaveLength(1);
  });

  it('uses the shared tooltip for the preview rather than a native title', () => {
    setInputs(component, {
      events: [routine('r1', 'A long notice', 1_000)],
      label: '1 system event',
      preview: 'A long notice',
    });
    fixture.detectChanges();

    expect(host.querySelector('[title]')).toBeNull();
  });
});
