import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  ɵresolveComponentResources as resolveComponentResources,
  signal,
} from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_SERVICE } from '../../../core/services/clipboard.service';
import type { ChildDiagnosticBundle } from '../../../../../shared/types/agent-tree.types';
import { ChildDiagnosticBundleModalComponent } from '../child-diagnostic-bundle.modal.component';
import { ChildDiagnosticBundleModalService } from '../child-diagnostic-bundle.modal.service';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(
  resolve(specDirectory, '../child-diagnostic-bundle.modal.component.html'),
  'utf8',
);
const styles = readFileSync(
  resolve(specDirectory, '../child-diagnostic-bundle.modal.component.scss'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('child-diagnostic-bundle.modal.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('child-diagnostic-bundle.modal.component.scss')) {
    return Promise.resolve(styles);
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('ChildDiagnosticBundleModalComponent', () => {
  let fixture: ComponentFixture<ChildDiagnosticBundleModalComponent>;
  let service: ChildDiagnosticBundleModalService;
  const fakeClipboard = {
    lastResult: signal(null).asReadonly(),
    copyText: vi.fn().mockResolvedValue({ ok: true }),
    copyJSON: vi.fn().mockResolvedValue({ ok: true }),
    copyImage: vi.fn().mockResolvedValue({ ok: true }),
  };

  const bundle: ChildDiagnosticBundle = {
    childId: 'child-1',
    parentId: 'parent-1',
    parentInstanceId: 'parent-1',
    childInstanceId: 'child-1',
    status: 'failed',
    provider: 'codex',
    model: 'gpt-5.5',
    workingDirectory: '/repo',
    task: 'Investigate failure',
    spawnTaskSummary: 'Investigate failure',
    spawnPromptHash: 'a'.repeat(64),
    statusTimeline: [{ status: 'busy', timestamp: 1_900_000_000_000 }],
    lastHeartbeatAt: 1_900_000_000_000,
    recentEvents: [{ type: 'error', summary: 'failed', timestamp: 1_900_000_000_001 }],
    recentOutput: [{ type: 'error', content: 'boom', timestamp: 1_900_000_000_002 }],
    recentOutputTail: [{ type: 'error', content: 'boom', timestamp: 1_900_000_000_002 }],
    artifactsSummary: {
      artifactCount: 0,
      artifactTypes: [],
      hasMoreDetails: false,
    },
    capturedAt: 1_900_000_000_003,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    TestBed.overrideComponent(ChildDiagnosticBundleModalComponent, {
      set: {
        template,
        templateUrl: undefined,
        styles: [styles],
        styleUrl: undefined,
        styleUrls: [],
      },
    });
    await TestBed.configureTestingModule({
      imports: [ChildDiagnosticBundleModalComponent],
      providers: [{ provide: CLIPBOARD_SERVICE, useValue: fakeClipboard }],
    }).compileComponents();

    service = TestBed.inject(ChildDiagnosticBundleModalService);
    fixture = TestBed.createComponent(ChildDiagnosticBundleModalComponent);
  });

  it('renders bundle data when opened', () => {
    service.open(bundle);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('child-1');
    expect(fixture.nativeElement.textContent).toContain('Investigate failure');
    expect(fixture.nativeElement.textContent).toContain('Status Timeline');
  });

  it('copies the prompt hash', () => {
    service.open(bundle);
    fixture.detectChanges();
    fixture.componentInstance.copyPromptHash();
    expect(fakeClipboard.copyText).toHaveBeenCalledWith(bundle.spawnPromptHash, { label: 'prompt hash' });
  });

  it('closes on escape handler', () => {
    service.open(bundle);
    fixture.detectChanges();
    fixture.componentInstance.onEscape();
    fixture.detectChanges();
    expect(service.bundle()).toBeNull();
    expect(fixture.nativeElement.querySelector('.modal')).toBeNull();
  });
});
