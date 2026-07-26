import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NO_ERRORS_SCHEMA,
  signal,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { DraftStore } from '../../core/draft-store';
import { GatewayClient } from '../../core/gateway-client.service';
import { HapticsService } from '../../core/haptics.service';
import { HostStore } from '../../core/host-store';
import { ImageAttachmentService } from '../../core/image-attachment.service';
import type { MobileSessionPlan } from '../../core/models';
import { VoiceInputService } from '../../core/voice-input.service';
import { NewSessionComponent } from './new-session.component';

await resolveComponentResources(() => Promise.resolve(''));

const RESOLVED_PLAN: MobileSessionPlan = {
  provider: 'codex',
  providerLabel: 'Codex',
  model: 'gpt-5.6',
  modelLabel: 'GPT-5.6',
  reasoningEffort: 'high',
  reasoningEffortLabel: 'High',
};

function buttonContaining(root: HTMLElement, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes(text));
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button containing "${text}" was not rendered`);
  }
  return button;
}

describe('NewSessionComponent structure', () => {
  const source = readFileSync(
    resolve('src/app/features/new-session/new-session.component.ts'),
    'utf8',
  );

  it('uses context selectors and one keyboard-anchored composer', () => {
    expect(source).toContain('class="session-context"');
    expect(source).toContain('class="new-session-composer"');
    expect(source).toContain('placeholder="Ask Harness"');
    expect(source).not.toContain('class="providers"');
    expect(source).not.toContain('class="cta"');
  });

  it('progressively discloses directory, settings, and attachment sheets', () => {
    expect(source).toContain('label="Working directory"');
    expect(source).toContain('label="Session settings"');
    expect(source).toContain('label="Add attachment"');
    expect(source).toContain('directorySheetOpen');
    expect(source).toContain('settingsSheetOpen');
    expect(source).toContain('attachmentSheetOpen');
  });

  it('keeps errors next to the composer and starts through form submission', () => {
    expect(source).toContain('role="alert"');
    expect(source).toContain('(submit)="create($event)"');
    expect(source).toContain('buildCreateInstanceRequest');
  });

  it('wires reasoning effort into the model sheet and session request', () => {
    expect(source).toContain('[reasoningOptions]="reasoningOptions()"');
    expect(source).toContain('[selectedReasoning]="reasoningEffort()"');
    expect(source).toContain('(chooseReasoning)="chooseReasoningEffort($event)"');
    expect(source).toContain('reasoningEffort: this.reasoningEffort()');
  });
});

describe('NewSessionComponent provider settings', () => {
  it('continues with the selected provider without forcing a model choice', async () => {
    const tap = vi.fn();
    TestBed.overrideComponent(NewSessionComponent, {
      set: {
        imports: [FormsModule],
        schemas: [NO_ERRORS_SCHEMA],
        styleUrls: [],
      },
    });
    await TestBed.configureTestingModule({
      imports: [NewSessionComponent],
      providers: [
        {
          provide: GatewayClient,
          useValue: {
            online: signal(true),
            snapshot: signal(null),
            recentDirs: vi.fn().mockResolvedValue([]),
            sessionPlan: vi.fn().mockResolvedValue(RESOLVED_PLAN),
          },
        },
        { provide: HostStore, useValue: { activeHost: signal(null) } },
        {
          provide: ImageAttachmentService,
          useValue: { available: false },
        },
        {
          provide: DraftStore,
          useValue: {
            load: vi.fn().mockResolvedValue(''),
            save: vi.fn(),
            clear: vi.fn(),
          },
        },
        {
          provide: HapticsService,
          useValue: { tap, success: vi.fn(), error: vi.fn() },
        },
        {
          provide: VoiceInputService,
          useValue: {
            available: false,
            listening: signal(false),
            text: signal(''),
            stop: vi.fn().mockResolvedValue(undefined),
          },
        },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(NewSessionComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    buttonContaining(fixture.nativeElement, 'Execution target').click();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('app-mobile-sheet[label="Session settings"]'),
    ).not.toBeNull();
    buttonContaining(fixture.nativeElement, 'Run with Codex').click();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('app-mobile-sheet[label="Session settings"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-model-sheet')).toBeNull();

    const continueButton = fixture.nativeElement.querySelector<HTMLButtonElement>(
      'button[aria-label="Continue with selected provider"]',
    );
    if (!(continueButton instanceof HTMLButtonElement)) {
      throw new Error('Continue with selected provider was not rendered');
    }

    continueButton.click();
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('app-mobile-sheet[label="Session settings"]'),
    ).toBeNull();
    expect(fixture.nativeElement.querySelector('app-model-sheet')).toBeNull();
    expect(buttonContaining(fixture.nativeElement, 'Execution target').textContent).toContain('Codex');
    expect(tap).toHaveBeenCalledTimes(2);
  });
});
