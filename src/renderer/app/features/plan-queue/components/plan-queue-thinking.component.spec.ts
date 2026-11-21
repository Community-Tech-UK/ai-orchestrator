import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import type { PlanQueueRouting } from '@contracts/schemas/plan-queue';
import { CopilotAccountIpcService } from '../../../core/services/ipc/copilot-account-ipc.service';
import { ProviderAccountIpcService } from '../../../core/services/ipc/provider-account-ipc.service';
import { SettingsStore } from '../../../core/state/settings.store';
import { UnifiedCatalogStore } from '../../models/unified-catalog.store';
import { PlanQueueRoutingPanelComponent } from './plan-queue-routing-panel.component';
import { planQueueRoutingSummary } from './plan-queue-run-list.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
await resolveComponentResources(url => Promise.resolve(url.endsWith('plan-queue-routing-panel.component.html')
  ? readFileSync(resolve(specDirectory, './plan-queue-routing-panel.component.html'), 'utf8') : ''));

it('edits, saves and clears thinking on all three queue route editors', async () => {
  const saved: PlanQueueRouting = { workers: [{ provider: 'claude', model: 'sonnet', reasoningEffort: 'low' }],
    verifiers: [{ provider: 'copilot', reasoningEffort: 'medium' }],
    stepUp: { provider: 'claude', model: 'opus', reasoningEffort: 'high' } };
  const settings = signal({ planQueueRouting: saved, providersExcludedFromAutomation: [] });
  const set = vi.fn(async (_key: string, routing: PlanQueueRouting) => { settings.update(value => ({ ...value, planQueueRouting: routing })); });
  await TestBed.configureTestingModule({ imports: [PlanQueueRoutingPanelComponent], providers: [
    { provide: SettingsStore, useValue: { settings, error: signal(null), clearError: vi.fn(), set } },
    { provide: ProviderAccountIpcService, useValue: { list: async () => ({ profiles: [] }) } },
    { provide: CopilotAccountIpcService, useValue: { list: async () => [] } },
    { provide: UnifiedCatalogStore, useValue: { ensureLoaded: vi.fn(), displayModelsForProvider: (provider: string) => provider === 'codex'
      ? [{ id: 'fast', name: 'Fast model', reasoning: { supportedEfforts: ['low'] } }] : [] } },
  ] }).compileComponents();
  const fixture = TestBed.createComponent(PlanQueueRoutingPanelComponent);
  fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  const root: HTMLElement = fixture.nativeElement;
  const choices = () => Array.from(root.querySelectorAll<HTMLSelectElement>('.pq-routing-thinking'));
  expect(choices().map(select => select.value)).toEqual(['low', 'medium', 'high']);
  choices()[0].value = 'medium'; choices()[0].dispatchEvent(new Event('change'));
  choices()[1].value = 'provider-default'; choices()[1].dispatchEvent(new Event('change'));
  choices()[2].value = 'max'; choices()[2].dispatchEvent(new Event('change'));
  fixture.detectChanges();
  await fixture.componentInstance.save(); fixture.detectChanges();
  expect(set).toHaveBeenCalledWith('planQueueRouting', {
    workers: [{ provider: 'claude', model: 'sonnet', reasoningEffort: 'medium' }],
    verifiers: [{ provider: 'copilot', reasoningEffort: null }], stepUp: { provider: 'claude', model: 'opus', reasoningEffort: 'max' },
  });
  expect(planQueueRoutingSummary(settings().planQueueRouting)).toContain('thinking: max');
  fixture.componentInstance.setProvider('workers', 0, 'opencode'); fixture.detectChanges();
  expect(root.querySelector('.pq-routing-worker .pq-routing-thinking')).toBeNull();
  fixture.componentInstance.setProvider('workers', 0, 'claude');
  fixture.componentInstance.setThinking('workers', 0, 'low');
  fixture.componentInstance.setModel('stepUp', 0, 'sonnet');
  fixture.componentInstance.setThinking('stepUp', 0, 'max');
  fixture.detectChanges();
  await fixture.componentInstance.save();
  expect(set).toHaveBeenCalledTimes(2);
  expect(settings().planQueueRouting.stepUp).toEqual({ provider: 'claude', model: 'sonnet', reasoningEffort: 'max' });
  fixture.componentInstance.setModel('stepUp', 0, 'sonnet-updated'); fixture.detectChanges();
  expect(choices().at(-1)?.value).toBe('max');
  fixture.componentInstance.setProvider('workers', 0, 'codex');
  fixture.componentInstance.setModel('workers', 0, 'fast');
  fixture.componentInstance.setThinking('workers', 0, 'max'); fixture.detectChanges();
  expect(root.textContent).toContain('thinking level is not available for this model');
  await fixture.componentInstance.save(); expect(set).toHaveBeenCalledTimes(2);
  fixture.componentInstance.setThinking('workers', 0, 'low'); fixture.detectChanges();
  await fixture.componentInstance.save(); expect(set).toHaveBeenCalledTimes(3);
});
