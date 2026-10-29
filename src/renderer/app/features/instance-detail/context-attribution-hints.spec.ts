import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, describe, expect, it } from 'vitest';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { ContextAttributionPanelComponent } from './context-attribution-panel.component';

afterEach(() => TestBed.resetTestingModule());

describe('context attribution hints', () => {
  it('keeps every explanation available through real hints and keyboard-reachable hosts or the visible legend', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: ElectronIpcService, useValue: { getApi: () => ({
      contextAttributionGet: async () => ({ success: true, data: {
        instanceId: 'example', computedAt: 1,
        buckets: [{ key: 'instructionFiles', tokens: 12, detail: [{ label: '/example/instructions.md', tokens: 12 }] }],
      } }),
      cacheAnalyticsGet: async () => ({ success: true, data: {
        samples: [{ ratio: 0.8 }, { ratio: 0.1 }],
        lastBreak: { ratio: 0.1, trailingMedian: 0.8 },
      } }),
      contextManifestGet: async () => ({ success: true, data: { history: [{
        epoch: 1, at: 1, trigger: 'spawn', entries: [{ kind: 'instructions', status: 'supplied', contentHash: 'example-hash', charLength: 12 }],
      }] } }),
    }) } }] });
    const fixture = TestBed.createComponent(ContextAttributionPanelComponent);
    fixture.componentRef.setInput('instanceId', 'example');
    fixture.detectChanges();
    await fixture.componentInstance.refresh();
    fixture.detectChanges();
    expect(fixture.componentInstance.error()).toBeNull();
    expect(fixture.componentInstance.attribution()).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
    const hints = fixture.debugElement.queryAll(By.directive(AioTooltipDirective));
    expect(hints, fixture.nativeElement.innerHTML).toHaveLength(6);
    for (const hint of hints) {
      expect(hint.injector.get(AioTooltipDirective).appTooltip()).toBeTruthy();
      const host: HTMLElement = hint.nativeElement;
      if (host.classList.contains('segment')) {
        expect(fixture.nativeElement.querySelector('.legend').textContent).toContain('Instruction files');
        expect(fixture.nativeElement.querySelector('.legend').textContent).toContain('12');
      } else {
        expect(host.tabIndex).toBe(0);
      }
    }
  });
});
