import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { ComposerQueueComponent } from './composer-queue.component';
import { glossaryPlain } from '../../shared/glossary/glossary';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './composer-queue.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './composer-queue.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('composer-queue.component.html')) return Promise.resolve(template);
  if (url.endsWith('composer-queue.component.scss')) return Promise.resolve(styles);
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

describe('ComposerQueueComponent', () => {
  it('shows the steering definition on keyboard-visible focus', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [ComposerQueueComponent] }).compileComponents();
    const fixture = TestBed.createComponent(ComposerQueueComponent);
    fixture.componentRef.setInput('messages', [{ message: 'change approach', kind: 'steer' }]);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('app-term button') as HTMLElement;
    const original = button.matches.bind(button);
    vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible' || original(selector));
    button.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent?.trim())
      .toBe(`${glossaryPlain('steer')} Select for more.`);
    fixture.destroy();
  });
  it('shows one crash-loss warning for multiple unsaved messages and removes it after save', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [ComposerQueueComponent] }).compileComponents();
    const fixture = TestBed.createComponent(ComposerQueueComponent);
    fixture.componentRef.setInput('messages', [{ message: 'one', notDurable: true }, { message: 'two', notDurable: true }]);
    fixture.detectChanges();
    const warnings = fixture.nativeElement.querySelectorAll('.queue-unsaved-warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].textContent).toBe('Not saved yet. If Harness crashes now, the marked message could be lost.');
    expect(warnings[0].getAttribute('role')).toBe('status');
    const chip = fixture.debugElement.query(By.css('.queued-drop-warning'));
    expect(chip.injector.get(AioTooltipDirective).appTooltip()).toBe('Not yet saved for crash recovery — a renderer crash right now could lose this message');
    expect(chip.nativeElement.getAttribute('tabindex')).toBe('0');
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
    fixture.componentRef.setInput('messages', [{ message: 'one' }, { message: 'two' }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.queue-unsaved-warning')).toBeNull();
    fixture.destroy();
  });

  it('renders queue metadata and emits edit/cancel/steer indexes', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [ComposerQueueComponent] }).compileComponents();
    const fixture = TestBed.createComponent(ComposerQueueComponent);
    (fixture.componentInstance as unknown as {
      messages: () => unknown[];
      holdReasonLabel: () => string;
      canSteer: () => boolean;
    }).messages = () => [
      { message: 'first', files: [new File(['x'], 'one.txt')] },
      { message: 'second', kind: 'steer', hadAttachmentsDropped: true },
    ];
    (fixture.componentInstance as unknown as {
      holdReasonLabel: () => string;
    }).holdReasonLabel = () => 'Provider limited';
    (fixture.componentInstance as unknown as {
      canSteer: () => boolean;
    }).canSteer = () => true;
    const edits: number[] = [];
    const cancels: number[] = [];
    const steers: number[] = [];
    fixture.componentInstance.editMessage.subscribe(index => edits.push(index));
    fixture.componentInstance.cancelMessage.subscribe(index => cancels.push(index));
    fixture.componentInstance.steerMessage.subscribe(index => steers.push(index));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.queue-badge').textContent).toContain('2');
    expect(fixture.nativeElement.querySelector('.queue-text').textContent).toContain('messages queued');
    expect(fixture.nativeElement.textContent).toContain('Provider limited');
    expect(fixture.nativeElement.textContent).toContain('1 attached');
    expect(fixture.nativeElement.textContent).toContain('attachments dropped');

    fixture.nativeElement.querySelectorAll('.queued-edit-btn')[1].click();
    fixture.nativeElement.querySelectorAll('.queued-cancel-btn')[0].click();
    fixture.nativeElement.querySelector('.queued-steer-btn').click();

    expect(edits).toEqual([1]);
    expect(cancels).toEqual([0]);
    expect(steers).toEqual([0]);
  });
});

describe('ComposerQueueComponent — parked queue (B7)', () => {
  async function mount(parked: boolean) {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [ComposerQueueComponent] }).compileComponents();
    const fixture = TestBed.createComponent(ComposerQueueComponent);
    const instance = fixture.componentInstance as unknown as {
      messages: () => unknown[];
      parked: () => boolean;
    };
    instance.messages = () => [{ message: 'held back' }];
    instance.parked = () => parked;
    fixture.detectChanges();
    return fixture;
  }

  it('says nothing about pausing while the queue is draining normally', async () => {
    const fixture = await mount(false);
    expect(fixture.nativeElement.querySelector('.queue-parked')).toBeNull();
  });

  it('explains that sending is paused rather than leaving it to look broken', async () => {
    const fixture = await mount(true);
    const banner = fixture.nativeElement.querySelector('.queue-parked') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('will not send until you resume');
  });

  it('offers a Resume action and emits it', async () => {
    const fixture = await mount(true);
    let resumed = 0;
    fixture.componentInstance.resumeQueue.subscribe(() => { resumed += 1; });
    (fixture.nativeElement.querySelector('.queue-parked__resume') as HTMLButtonElement).click();
    expect(resumed).toBe(1);
  });

  it('announces the pause rather than only drawing it', async () => {
    const fixture = await mount(true);
    expect((fixture.nativeElement.querySelector('.queue-parked') as HTMLElement).getAttribute('role'))
      .toBe('status');
  });

  it('still lists the held messages, so the user sees what is waiting', async () => {
    const fixture = await mount(true);
    expect(fixture.nativeElement.textContent).toContain('held back');
  });
});
