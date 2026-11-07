import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ContextMeasuredViewComponent } from './context-measured-view.component';
import { InstanceStore } from '../../core/state/instance.store';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
describe('measured context view', () => {
  it('renders the measured label and advice and dispatches Compact now through the existing store', async () => {
    const compactInstance = vi.fn().mockResolvedValue(undefined);
    const contextProviderMeasure = vi.fn().mockResolvedValue({ success: true, data: { status: 'measured',
      measured: { totalTokens: 40000, maxTokens: 200000, categories: [{ name: 'Messages', tokens: 40000 }], memoryFiles: [], connectorTools: [], topTools: [] },
      advice: [{ id: 'tool-output', level: 'act', text: 'Tool output is large.', action: 'compact-now' }] } });
    TestBed.configureTestingModule({ imports: [ContextMeasuredViewComponent], providers: [
      { provide: InstanceStore, useValue: { getInstance: () => ({ status: 'idle' }), compactInstance } },
      { provide: ElectronIpcService, useValue: { getApi: () => ({ contextProviderMeasure }) } },
    ] });
    const fixture = TestBed.createComponent(ContextMeasuredViewComponent);
    (fixture.componentInstance as unknown as { instanceId: () => string }).instanceId = () => 'i';
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Measured by Claude');
    expect(fixture.nativeElement.textContent).toContain('Tool output is large');
    const compact = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    compact.find(button => button.textContent === 'Compact now')!.click(); await fixture.whenStable();
    expect(compactInstance).toHaveBeenCalledWith('i');
  });
});
