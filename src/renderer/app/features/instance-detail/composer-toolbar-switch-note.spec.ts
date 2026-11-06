import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerToolbarComponent } from './composer-toolbar.component';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import { ToastService } from '../../core/services/toast.service';
import { ProviderAccountIpcService } from '../../core/services/ipc/provider-account-ipc.service';

/**
 * Plan 12a/14d: the line shown above the model list before a switch. The
 * toolbar owns `modelSwitchNoteForProvider` and hands it to the picker, which
 * hands it to the panel; this renders all three layers and reads the note a
 * person would read. A system-only buffer (a session banner, nothing said yet)
 * has no conversation, so no note; a real conversation has one.
 */
describe('Composer toolbar switch note (rendered through picker and panel)', () => {
  let fixture: ComponentFixture<ComposerToolbarComponent>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ComposerToolbarComponent],
      providers: [
        { provide: InstanceIpcService, useValue: { changeModel: vi.fn() } },
        { provide: InstanceStore, useValue: {} },
        { provide: ToastService, useValue: { show: vi.fn() } },
        { provide: ProviderAccountIpcService, useValue: { list: vi.fn().mockResolvedValue({ profiles: [], pools: {} }) } },
      ],
    });
    fixture = TestBed.createComponent(ComposerToolbarComponent);
    fixture.componentRef.setInput('instanceId', 'real-1');
    fixture.componentRef.setInput('instanceStatus', 'idle');
    fixture.componentRef.setInput('provider', 'claude');
    fixture.componentRef.setInput('currentModel', 'sonnet');
  });

  afterEach(() => {
    fixture.destroy();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => { el.innerHTML = ''; });
  });

  /** Opens the real picker menu and returns the note text a person would read, or null. */
  function openPickerNote(): string | null {
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.compact-picker__chip') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(document.querySelector('app-model-selection-panel'), 'the menu opened').not.toBeNull();
    return document.querySelector('.model-picker-note[role="note"]')?.textContent?.trim() ?? null;
  }

  it('shows no note when the buffer has no conversation (system lines only)', () => {
    fixture.componentRef.setInput('hasConversation', false);
    fixture.componentRef.setInput('residentClaude', true);
    expect(openPickerNote()).toBeNull();
  });

  it('shows the in-place sentence for a real conversation on a resident Claude session', () => {
    fixture.componentRef.setInput('hasConversation', true);
    fixture.componentRef.setInput('residentClaude', true);
    expect(openPickerNote()).toContain('Switches in place.');
  });

  it('says the session restarts for a real conversation that is not resident', () => {
    fixture.componentRef.setInput('hasConversation', true);
    fixture.componentRef.setInput('residentClaude', false);
    expect(openPickerNote()).toContain('Switching starts a fresh Claude session.');
  });

  it('keeps the restart sentence for remote Claude even when the flag is set', () => {
    fixture.componentRef.setInput('hasConversation', true);
    fixture.componentRef.setInput('residentClaude', true);
    fixture.componentRef.setInput('remoteExecution', true);
    expect(openPickerNote()).toContain('Switching starts a fresh Claude session.');
  });

  it('changes with the conversation after the picker has been mounted', () => {
    fixture.componentRef.setInput('hasConversation', false);
    fixture.componentRef.setInput('residentClaude', true);
    expect(openPickerNote()).toBeNull();

    fixture.componentRef.setInput('hasConversation', true);
    fixture.detectChanges();
    expect(document.querySelector('.model-picker-note[role="note"]')?.textContent).toContain('Switches in place.');
  });

  it('shows shortened replay in the real Gemini picker', () => {
    fixture.componentRef.setInput('provider', 'gemini');
    fixture.componentRef.setInput('currentModel', 'gemini-3.1-pro-preview');
    fixture.componentRef.setInput('hasConversation', true);
    expect(openPickerNote()).toContain('recent messages in shortened form');
  });

  it('uses local-model runtime truth even when the instance carries a CLI provider', () => {
    fixture.componentRef.setInput('provider', 'codex');
    fixture.componentRef.setInput('hasConversation', true);
    fixture.componentRef.setInput('runtimeSummary', { kind: 'local-model', label: 'Fixture local model' });
    expect(fixture.componentInstance.modelSwitchNoteForProvider('codex')).toContain('starts a new session');
  });
});
