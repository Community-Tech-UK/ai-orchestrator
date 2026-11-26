import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { IpcFacadeService, InstanceIpcService } from '../../core/services/ipc';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { MarkdownService } from '../../core/services/markdown.service';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { InstanceOutputStore } from '../../core/state/instance/instance-output.store';
import { InstanceStore } from '../../core/state/instance/instance.store';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import { SettingsStore } from '../../core/state/settings.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { AppIconButtonDirective } from '../../shared/tooltip/icon-button.directive';
import { OutputStreamComponent } from './output-stream.component';

const template = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), './output-stream.component.html'), 'utf8');
await resolveComponentResources(url => Promise.resolve(url.endsWith('output-stream.component.html') ? template : ''));

describe('OutputStream live virtualization setting', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  it('switches the existing transcript DOM into spacers and back immediately without recreating the component', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const settings = signal({ transcriptVirtualization: false, progressNoteDisplay: 'full' });
    TestBed.configureTestingModule({
      imports: [OutputStreamComponent],
      providers: [
        { provide: SettingsStore, useValue: { settings } },
        { provide: MarkdownService, useValue: {
          render: (content: string) => content, highlightCodeBlocksInElement: vi.fn(),
        } },
        { provide: IpcFacadeService, useValue: {} },
        { provide: InstanceIpcService, useValue: {
          loadOlderMessages: vi.fn(async () => ({ success: true, data: { messages: [], hasMore: false, totalStored: 0 } })),
        } },
        { provide: InstanceOutputStore, useValue: { releaseLoadedHistory: vi.fn() } },
        // No live session: turn notes then ask for no folder comparison.
        { provide: InstanceStore, useValue: { getInstance: () => undefined } },
        { provide: PerfInstrumentationService, useValue: {
          markThreadSwitch: () => () => undefined, markTranscriptPaint: () => () => undefined,
          recordDisplayItemsCompute: vi.fn(), recordMarkdownRender: vi.fn(), recordScrollFrame: vi.fn(),
        } },
        { provide: CLIPBOARD_SERVICE, useValue: {} },
        { provide: FileIpcService, useValue: {} },
        { provide: CrossModelReviewIpcService, useValue: {} },
      ],
    });
    // Keep the production transcript template and its real render pipeline.
    // Unrelated child widgets are opaque, so no rail or menu can alter scroll.
    TestBed.overrideComponent(OutputStreamComponent, { set: {
      imports: [DatePipe, NgTemplateOutlet, AioTooltipDirective, AppIconButtonDirective],
      template, templateUrl: undefined, styles: [], styleUrl: undefined, styleUrls: [],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    } });
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(OutputStreamComponent);
    const messages: OutputMessage[] = Array.from({ length: 80 }, (_, index) => ({
      id: `message-${index}`, timestamp: index + 1,
      type: index % 2 === 0 ? 'user' : 'assistant', content: `Message ${index}`,
    }));
    fixture.componentRef.setInput('instanceId', 'disposable-transcript');
    fixture.componentRef.setInput('messages', messages);
    fixture.componentRef.setInput('livePromptIndexEnabled', false);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    const viewport = root.querySelector<HTMLDivElement>('.output-stream')!;
    Object.defineProperties(viewport, {
      clientHeight: { value: 192, configurable: true },
      scrollHeight: { value: 80 * 96, configurable: true },
    });
    while (frames.length) frames.shift()!(0);
    viewport.scrollTop = 2000;
    viewport.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    const rowIds = () => Array.from(root.querySelectorAll('.transcript-item')).map(row => row.getAttribute('data-item-id'));
    const allRows = rowIds();
    expect(allRows.length).toBeGreaterThan(40);
    expect(root.querySelector('.transcript-spacer')).toBeNull();

    settings.update(current => ({ ...current, transcriptVirtualization: true }));
    fixture.detectChanges();
    expect(rowIds().length).toBeLessThan(allRows.length);
    expect(rowIds()).toContain(allRows[0]); // the first user prompt stays pinned
    const spacers = Array.from(root.querySelectorAll<HTMLElement>('.transcript-spacer'));
    expect(spacers.length).toBeGreaterThan(0);
    for (const spacer of spacers) {
      expect(spacer.getAttribute('aria-hidden')).toBe('true');
      expect(parseFloat(spacer.style.height)).toBeGreaterThan(0);
    }
    expect(fixture.componentInstance.container()?.nativeElement).toBe(viewport);

    settings.update(current => ({ ...current, transcriptVirtualization: false }));
    fixture.detectChanges();
    expect(rowIds()).toEqual(allRows);
    expect(root.querySelector('.transcript-spacer')).toBeNull();
    expect(fixture.componentInstance.container()?.nativeElement).toBe(viewport);
    fixture.destroy();
  });
});
