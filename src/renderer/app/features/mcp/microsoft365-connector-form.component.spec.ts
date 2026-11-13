import { TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { McpIpcService } from '../../core/services/ipc/mcp-ipc.service';
import { Microsoft365ConnectorFormComponent } from './microsoft365-connector-form.component';

await resolveComponentResources(url => Promise.resolve(readFileSync(fileURLToPath(new URL(url, import.meta.url)), 'utf8')));

describe('Microsoft365ConnectorFormComponent', () => {
  const add = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    add.mockResolvedValue({ success: true, data: { username: 'reader@example.test' } });
    TestBed.configureTestingModule({ providers: [{ provide: McpIpcService, useValue: { connectorAddMicrosoft365: add } }] });
  });

  function create() {
    const fixture = TestBed.createComponent(Microsoft365ConnectorFormComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('connects with a unique automatic name without asking for technical settings', async () => {
    const fixture = create();
    fixture.componentRef.setInput('existingNames', ['M365-account', 'm365-account-2']);
    const added = vi.fn();
    fixture.componentInstance.added.subscribe(added);
    await fixture.componentInstance.connect(new Event('submit'));
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ name: 'm365-account-3', mailEnabled: true }));
    expect(added).toHaveBeenCalledWith('reader@example.test');
    expect(fixture.nativeElement.querySelector('input[required]')).toBeNull();
  });

  it('turns an optional nickname into a valid unique connector name and respects calendar-only access', async () => {
    const fixture = create();
    fixture.componentRef.setInput('existingNames', ['m365-dingley-promise']);
    fixture.componentInstance.nickname.set('Dingley Promise');
    fixture.componentInstance.mailEnabled.set(false);
    await fixture.componentInstance.connect(new Event('submit'));
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ name: 'm365-dingley-promise-2', mailEnabled: false }));
  });

  it('blocks repeated submissions while Microsoft sign-in is pending', async () => {
    let finish!: (value: unknown) => void;
    add.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const fixture = create();
    const first = fixture.componentInstance.connect(new Event('submit'));
    await fixture.componentInstance.connect(new Event('submit'));
    fixture.detectChanges();
    expect(add).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.textContent).toContain('Complete Microsoft sign-in in your browser');
    expect(fixture.nativeElement.querySelector('button[type="submit"]').disabled).toBe(true);
    finish({ success: true, data: { username: 'reader@example.test' } });
    await first;
    expect(fixture.componentInstance.pending()).toBe(false);
  });

  it('keeps choices on a sign-in failure and permits retrying', async () => {
    add.mockResolvedValueOnce({ success: false, error: { message: 'Administrator approval is required.' } });
    const fixture = create();
    fixture.componentInstance.nickname.set('Dingley');
    await fixture.componentInstance.connect(new Event('submit'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('could not connect');
    expect(fixture.componentInstance.nickname()).toBe('Dingley');
    expect(fixture.componentInstance.errorDetails()).toBe('Administrator approval is required.');
    expect(fixture.componentInstance.pending()).toBe(false);
    await fixture.componentInstance.connect(new Event('submit'));
    expect(add).toHaveBeenCalledTimes(2);
  });

  it('requires at least one AI tool and never opens sign-in with no destination', async () => {
    const fixture = create();
    fixture.componentInstance.providers.set([]);
    await fixture.componentInstance.connect(new Event('submit'));
    expect(add).not.toHaveBeenCalled();
    expect(fixture.componentInstance.error()).toContain('Choose at least one AI tool');
  });
});
