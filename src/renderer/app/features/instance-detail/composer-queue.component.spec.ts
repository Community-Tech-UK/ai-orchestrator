import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { ComposerQueueComponent } from './composer-queue.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './composer-queue.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './composer-queue.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('composer-queue.component.html')) return Promise.resolve(template);
  if (url.endsWith('composer-queue.component.scss')) return Promise.resolve(styles);
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

describe('ComposerQueueComponent', () => {
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
