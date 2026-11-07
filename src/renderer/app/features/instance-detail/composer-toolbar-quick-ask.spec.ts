import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceStatus } from '../../core/state/instance/instance.types';
import { ComposerToolbarComponent } from './composer-toolbar.component';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import { ToastService } from '../../core/services/toast.service';
import { ProviderAccountIpcService } from '../../core/services/ipc/provider-account-ipc.service';
import { resolveContextEvidenceTemplate } from './composer-toolbar-test-resources';

await resolveContextEvidenceTemplate();

/**
 * Plan 14c: the "Quick ask" trigger in the composer toolbar. Shown for a Claude
 * session that is idle, busy or waiting for input (a quick ask is allowed while
 * a turn runs; that is the point), hidden for every other status and provider.
 * Clicking it emits `quickAskRequested`, which the input panel listens to in
 * order to open the Quick ask panel. This renders the real toolbar.
 */
describe('Composer toolbar Quick ask button (R4K4 V10)', () => {
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

  function quickAskButton(): HTMLButtonElement | null {
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('button.quick-ask-trigger') as HTMLButtonElement | null;
  }

  it.each<InstanceStatus>(['idle', 'busy', 'waiting_for_input'])('shows the button for Claude while %s', (status) => {
    fixture.componentRef.setInput('instanceStatus', status);
    const button = quickAskButton();
    expect(button, `visible while ${status}`).not.toBeNull();
    expect(button!.textContent?.trim()).toBe('Quick ask');
    expect(button!.getAttribute('type')).toBe('button');
    // The explanation is a tooltip from the shared copy table, never a native title.
    expect(button!.hasAttribute('title')).toBe(false);
  });

  it.each<InstanceStatus>([
    'initializing', 'ready', 'processing', 'thinking_deeply', 'waiting_for_permission', 'interrupting',
    'cancelling', 'interrupt-escalating', 'cancelled', 'superseded', 'respawning', 'hibernating',
    'hibernated', 'waking', 'degraded', 'error', 'failed', 'terminated',
  ])('hides the button for Claude while %s', (status) => {
    fixture.componentRef.setInput('instanceStatus', status);
    expect(quickAskButton()).toBeNull();
  });

  it('hides the button when the status is not known yet', () => {
    fixture.componentRef.setInput('instanceStatus', undefined);
    expect(quickAskButton()).toBeNull();
  });

  it.each(['codex', 'gemini', 'copilot', 'cursor', 'opencode', 'grok', 'ollama', 'antigravity'] as const)(
    'hides the button for %s even when idle',
    (provider) => {
      fixture.componentRef.setInput('provider', provider);
      fixture.componentRef.setInput('instanceStatus', 'idle');
      expect(quickAskButton()).toBeNull();
    },
  );

  it('follows the status after the toolbar is mounted', () => {
    expect(quickAskButton()).not.toBeNull();

    fixture.componentRef.setInput('instanceStatus', 'respawning');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button.quick-ask-trigger')).toBeNull();

    fixture.componentRef.setInput('instanceStatus', 'busy');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button.quick-ask-trigger')).not.toBeNull();
  });

  it('emits quickAskRequested, once per click, when the button is clicked', () => {
    const requested = vi.fn();
    fixture.componentInstance.quickAskRequested.subscribe(requested);

    const button = quickAskButton();
    expect(button).not.toBeNull();
    expect(requested).not.toHaveBeenCalled();

    button!.click();
    expect(requested).toHaveBeenCalledTimes(1);
    button!.click();
    expect(requested).toHaveBeenCalledTimes(2);
  });
});
