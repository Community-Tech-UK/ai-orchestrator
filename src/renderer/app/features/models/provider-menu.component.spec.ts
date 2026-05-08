import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import { ProviderMenuComponent, PROVIDER_MENU_ORDER } from './provider-menu.component';
import type { ChatProvider } from '../../../../shared/types/chat.types';

describe('ProviderMenuComponent', () => {
  let fixture: ComponentFixture<ProviderMenuComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ProviderMenuComponent] });
    fixture = TestBed.createComponent(ProviderMenuComponent);
  });

  it('renders the four chat providers in fixed order, no auto / no cursor', () => {
    fixture.componentRef.setInput('selectedProvider', 'claude');
    fixture.detectChanges();

    const labels = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-row__label'))
      .map((el) => (el as HTMLElement).textContent?.trim());
    expect(labels).toEqual(['Claude', 'Codex', 'Gemini', 'Copilot']);
    expect(PROVIDER_MENU_ORDER).toEqual(['claude', 'codex', 'gemini', 'copilot']);
  });

  it('marks the selected provider with aria-checked="true"', () => {
    fixture.componentRef.setInput('selectedProvider', 'codex');
    fixture.detectChanges();

    const rows = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-row__body')) as HTMLElement[];
    const codexRow = rows.find((r) => r.textContent?.includes('Codex'));
    expect(codexRow?.getAttribute('aria-checked')).toBe('true');
    const claudeRow = rows.find((r) => r.textContent?.includes('Claude'));
    expect(claudeRow?.getAttribute('aria-checked')).toBeNull();
  });

  it('disables providers per disabledReasonFor and surfaces reason via title', () => {
    fixture.componentRef.setInput('selectedProvider', 'claude');
    fixture.componentRef.setInput('disabledReasonFor', (p: ChatProvider) =>
      p === 'codex' ? 'Provider can only be changed before the first message' : undefined,
    );
    fixture.detectChanges();

    const rows = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-row__body')) as HTMLElement[];
    const codexRow = rows.find((r) => r.textContent?.includes('Codex'))!;
    expect(codexRow.getAttribute('aria-disabled')).toBe('true');
    expect(codexRow.getAttribute('title')).toContain('before the first message');
  });

  it('emits providerSelect with the chosen provider on row click', () => {
    fixture.componentRef.setInput('selectedProvider', 'claude');
    fixture.detectChanges();
    let emitted: ChatProvider | null = null;
    fixture.componentInstance.providerSelect.subscribe((p) => (emitted = p));

    const rows = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-row__body')) as HTMLElement[];
    rows.find((r) => r.textContent?.includes('Gemini'))!.click();

    expect(emitted).toBe('gemini');
  });

  it('does not emit for a disabled provider', () => {
    fixture.componentRef.setInput('selectedProvider', 'claude');
    fixture.componentRef.setInput('disabledReasonFor', (p: ChatProvider) =>
      p === 'codex' ? 'no' : undefined,
    );
    fixture.detectChanges();
    let emitted = false;
    fixture.componentInstance.providerSelect.subscribe(() => (emitted = true));

    const rows = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-row__body')) as HTMLElement[];
    rows.find((r) => r.textContent?.includes('Codex'))!.click();

    expect(emitted).toBe(false);
  });
});
