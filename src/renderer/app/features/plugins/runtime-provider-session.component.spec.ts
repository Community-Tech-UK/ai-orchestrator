import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginIpcService } from '../../core/services/ipc/plugin-ipc.service';
import { RuntimeProviderSessionComponent } from './runtime-provider-session.component';

describe('one-message provider sessions', () => {
  const ipc = {
    runtimeProviderList: vi.fn(), runtimeProviderSend: vi.fn(),
  };
  beforeEach(async () => {
    vi.resetAllMocks();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [RuntimeProviderSessionComponent], providers: [{ provide: PluginIpcService, useValue: ipc }],
    }).compileComponents();
    ipc.runtimeProviderList.mockResolvedValue({ success: true, data: {
      providers: [{ provider: 'plugin:proof', name: 'Fixture provider' }], failures: [],
    } });
    ipc.runtimeProviderSend.mockResolvedValue({ success: true, data: { content: 'Actual reply' } });
  });

  it('runs the explicit selection and send flow and renders the returned assistant text', async () => {
    const fixture = TestBed.createComponent(RuntimeProviderSessionComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();
    expect(ipc.runtimeProviderList).not.toHaveBeenCalled();
    component.changeFolder('/fixture');
    await component.refresh();
    component.changeMessage('hello');
    await component.send();
    fixture.detectChanges();
    expect(ipc.runtimeProviderSend).toHaveBeenCalledWith({ workingDirectory: '/fixture', provider: 'plugin:proof', message: 'hello' });
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="status"]')?.textContent).toBe('Actual reply');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('may charge');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('fresh session');
  });

  it('invalidates a selection when the working folder changes', async () => {
    const component = TestBed.createComponent(RuntimeProviderSessionComponent).componentInstance;
    component.changeFolder('/first');
    await component.refresh();
    component.changeMessage('hello');
    expect(component.canSend()).toBe(true);
    component.changeFolder('/second');
    await component.send();
    expect(component.providers()).toEqual([]);
    expect(ipc.runtimeProviderSend).not.toHaveBeenCalled();
  });

  it('announces failure and removes a stale reply rather than claiming a response', async () => {
    const fixture = TestBed.createComponent(RuntimeProviderSessionComponent);
    const component = fixture.componentInstance;
    component.changeFolder('/fixture');
    await component.refresh();
    component.changeMessage('hello');
    await component.send();
    ipc.runtimeProviderSend.mockResolvedValue({ success: false, error: { message: 'Worker stopped' } });
    await component.send();
    fixture.detectChanges();
    expect(component.reply()).toBe('');
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent).toContain('could not finish');
    expect((fixture.nativeElement as HTMLElement).querySelector('details')?.textContent).toContain('Worker stopped');
    expect(component.busy()).toBe(false);
  });

  it('sends the provider and message chosen through the form controls', async () => {
    ipc.runtimeProviderList.mockResolvedValue({ success: true, data: {
      providers: [
        { provider: 'plugin:proof', name: 'First provider' },
        { provider: 'plugin:second', name: 'Second provider' },
      ], failures: [],
    } });
    const fixture = TestBed.createComponent(RuntimeProviderSessionComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const folder = root.querySelector('input')!;
    folder.value = '/fixture';
    folder.dispatchEvent(new Event('input'));
    await fixture.componentInstance.refresh();
    fixture.detectChanges();
    const provider = root.querySelector('select')!;
    provider.value = 'plugin:second';
    provider.dispatchEvent(new Event('change'));
    const message = root.querySelector('textarea')!;
    message.value = 'Chosen message';
    message.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const send = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Send')!;
    expect(send.disabled).toBe(false);
    send.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(ipc.runtimeProviderSend).toHaveBeenCalledWith({
      workingDirectory: '/fixture', provider: 'plugin:second', message: 'Chosen message',
    });
    expect(root.querySelector('[role="status"]')?.textContent).toBe('Actual reply');
  });
});
