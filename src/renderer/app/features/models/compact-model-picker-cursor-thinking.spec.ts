import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatStore } from '../../core/state/chat.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { CompactModelPickerComponent } from './compact-model-picker.component';
import { DynamicModelCatalogService } from './dynamic-model-catalog.service';
import { UnifiedCatalogStore } from './unified-catalog.store';

describe('Cursor thinking level on the composer model chip', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [CompactModelPickerComponent],
      providers: [
        { provide: ChatStore, useValue: {} },
        { provide: DynamicModelCatalogService, useValue: { ensureLoaded: vi.fn() } },
        { provide: UnifiedCatalogStore, useValue: {
          ensureLoaded: vi.fn(), displayModelsForProvider: () => [], lastBuiltAt: signal(null),
        } },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  it.each([
    ['grok-4.7', 'Cursor default'],
    ['auto', 'Cursor default'],
    ['composer-2.5', 'Cursor default'],
    ['grok-4.7-low', 'Low'],
    ['grok-4.7-medium-fast', 'Medium'],
    ['grok-4.7-high', 'High'],
    ['grok-4.7-xhigh-fast', 'XHigh'],
    ['gpt-5.5-extra-high-fast', 'XHigh'],
    ['claude-4.6-opus-max-thinking', 'Max'],
    ['gpt-5.6-sol-none', 'Off'],
    ['claude-opus-4-8[context=1m,effort=high,fast=false]', 'High'],
    ['gpt-5.3-codex[reasoning=medium,fast=false]', 'Medium'],
    ['grok-4.7[effort=future]', 'Cursor default'],
  ])('shows the level described by %s', (model, label) => {
    const fixture = TestBed.createComponent(CompactModelPickerComponent);
    fixture.componentRef.setInput('mode', 'pending-create');
    fixture.componentRef.setInput('selection', { provider: 'cursor', model, reasoning: null });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.compact-picker__reasoning-suffix')?.textContent)
      .toContain(`Thinking: ${label}`);
  });

  it('follows Cursor model changes instead of a separate effort that Cursor does not receive', () => {
    const fixture = TestBed.createComponent(CompactModelPickerComponent);
    fixture.componentRef.setInput('mode', 'pending-create');
    fixture.componentRef.setInput('selection', { provider: 'cursor', model: 'grok-4.7-low', reasoning: 'high' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.compact-picker__reasoning-suffix')?.textContent)
      .toContain('Thinking: Low');

    fixture.componentRef.setInput('selection', { provider: 'cursor', model: 'grok-4.7-xhigh', reasoning: null });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.compact-picker__reasoning-suffix')?.textContent)
      .toContain('Thinking: XHigh');
  });

  it.each(['max', 'workflow'])('ignores an independent %s effort in the Cursor chip tooltip', (reasoning) => {
    const fixture = TestBed.createComponent(CompactModelPickerComponent);
    fixture.componentRef.setInput('mode', 'pending-create');
    fixture.componentRef.setInput('selection', { provider: 'cursor', model: 'grok-4.7-low', reasoning });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.compact-picker__reasoning-suffix')?.textContent)
      .toContain('Thinking: Low');
    const tooltip = fixture.debugElement.query(By.css('.compact-picker__chip')).injector.get(AioTooltipDirective);
    expect(tooltip.appTooltip()).toBeNull();
  });
});
