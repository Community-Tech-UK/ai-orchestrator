import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { RequestReceiptsComponent, type RequestReceipt } from './request-receipts.component';

function receipt(id: string, text: string, subject?: string): RequestReceipt {
  return { id, requestId: id, instanceId: 'inst-1', text, subject, expiresAt: 1 };
}

function mount(receipts: RequestReceipt[]) {
  const fixture = TestBed.createComponent(RequestReceiptsComponent);
  fixture.componentRef.setInput('receipts', receipts);
  fixture.detectChanges();
  return fixture;
}

describe('RequestReceiptsComponent', () => {
  it('shows one plain line per receipt, with the tool after the sentence', () => {
    const fixture = mount([receipt('a', 'Answered elsewhere', 'Bash'), receipt('b', 'You answered: Bun')]);
    const lines = Array.from(fixture.nativeElement.querySelectorAll('.receipt')) as HTMLElement[];
    expect(lines.map((line) => line.querySelector('.receipt-text')?.textContent)).toEqual([
      'Answered elsewhere',
      'You answered: Bun',
    ]);
    expect(lines[0].querySelector('.receipt-subject')?.textContent).toBe('(Bash)');
    expect(lines[1].querySelector('.receipt-subject')).toBeNull();
  });

  it('renders nothing visible when there are no receipts', () => {
    const fixture = mount([]);
    expect(fixture.nativeElement.querySelector('.receipt')).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent?.trim()).toBe('');
  });

  it('lets the person dismiss a receipt', () => {
    const fixture = mount([receipt('a', 'Answered elsewhere')]);
    const dismissed = vi.fn();
    fixture.componentInstance.dismissed.subscribe(dismissed);
    (fixture.nativeElement.querySelector('.receipt-dismiss') as HTMLButtonElement).click();
    expect(dismissed).toHaveBeenCalledWith('a');
  });

  it('announces new receipts politely and names which one a Dismiss button belongs to', () => {
    const fixture = mount([receipt('a', 'Answered elsewhere')]);
    expect(fixture.nativeElement.querySelector('.receipts')?.getAttribute('aria-live')).toBe('polite');
    expect(fixture.nativeElement.querySelector('.receipt-dismiss')?.getAttribute('aria-label')).toBe('Dismiss: Answered elsewhere');
  });
});
