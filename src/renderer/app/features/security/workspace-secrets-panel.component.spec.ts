import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IpcFacadeService } from '../../core/services/ipc';
import { WorkspaceSecretsPanelComponent } from './workspace-secrets-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
await resolveComponentResources((url) => {
  if (url.endsWith('workspace-secrets-panel.component.html')) {
    return Promise.resolve(readFileSync(resolve(specDirectory, 'workspace-secrets-panel.component.html'), 'utf8'));
  }
  if (url.endsWith('workspace-secrets-panel.component.scss')) {
    return Promise.resolve(readFileSync(resolve(specDirectory, 'workspace-secrets-panel.component.scss'), 'utf8'));
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('WorkspaceSecretsPanelComponent', () => {
  let fixture: ComponentFixture<WorkspaceSecretsPanelComponent>;
  const ipc = {
    listWorkspaceSecrets: vi.fn(),
    getWorkspaceSecretAudit: vi.fn(),
    forgetWorkspaceSecret: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    ipc.listWorkspaceSecrets.mockResolvedValue({ success: true, data: [] });
    ipc.getWorkspaceSecretAudit.mockResolvedValue({ success: true, data: [] });
    ipc.forgetWorkspaceSecret.mockResolvedValue({ success: true, data: { forgotten: true } });
    await TestBed.configureTestingModule({
      imports: [WorkspaceSecretsPanelComponent],
      providers: [{ provide: IpcFacadeService, useValue: ipc }],
    }).compileComponents();
    fixture = TestBed.createComponent(WorkspaceSecretsPanelComponent);
    fixture.detectChanges();
  });

  it('shows the slug, timestamps, and workspace-scoped audit without any value field', async () => {
    ipc.listWorkspaceSecrets.mockResolvedValue({
      success: true,
      data: [{
        name: 'example-key', label: 'Example key', purpose: 'Connect workspace',
        createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000, lastUsedAt: null,
      }],
    });
    ipc.getWorkspaceSecretAudit.mockResolvedValue({
      success: true,
      data: [{
        id: 'audit-1', secretName: 'example-key', event: 'created',
        instanceId: 'instance-1', purpose: 'Connect workspace', at: 1_700_000_000_000,
      }],
    });

    const path = fixture.nativeElement.querySelector('.path-field input') as HTMLInputElement;
    path.value = '/example/workspace';
    path.dispatchEvent(new Event('input'));
    await fixture.componentInstance.refresh();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(ipc.listWorkspaceSecrets).toHaveBeenCalledWith('/example/workspace');
    expect(ipc.getWorkspaceSecretAudit).toHaveBeenCalledWith('/example/workspace', 100);
    expect(text).toContain('Name: example-key');
    expect(text).toContain('Created:');
    expect(text).toContain('Updated:');
    expect(text).toContain('Last used: Never');
    expect(text).toContain('Recent secret activity');
    expect(text).toContain('example-key created');
    expect(text).toContain('Session: instance-1');
    expect(JSON.stringify(fixture.componentInstance.secrets())).not.toContain('value');
  });

  it('clears the previous workspace metadata as soon as the directory changes', async () => {
    ipc.listWorkspaceSecrets.mockResolvedValue({
      success: true,
      data: [{ name: 'old-workspace-key', label: 'Old key', purpose: '', createdAt: 1, updatedAt: 1, lastUsedAt: null }],
    });
    ipc.getWorkspaceSecretAudit.mockResolvedValue({
      success: true,
      data: [{ id: 'old-audit', secretName: 'old-workspace-key', event: 'created', instanceId: null, purpose: '', at: 1 }],
    });
    const path = fixture.nativeElement.querySelector('.path-field input') as HTMLInputElement;
    path.value = '/old/workspace';
    path.dispatchEvent(new Event('input'));
    await fixture.componentInstance.refresh();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('old-workspace-key');

    path.value = '/new/workspace';
    path.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('old-workspace-key');
  });

  it('ignores a stale refresh after the directory changes and a newer refresh starts', async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    ipc.listWorkspaceSecrets.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const path = fixture.nativeElement.querySelector('.path-field input') as HTMLInputElement;
    path.value = '/old/workspace';
    path.dispatchEvent(new Event('input'));
    const oldRefresh = fixture.componentInstance.refresh();

    path.value = '/new/workspace';
    path.dispatchEvent(new Event('input'));
    ipc.listWorkspaceSecrets.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'new-key', label: 'New key', purpose: '', createdAt: 1, updatedAt: 1, lastUsedAt: null }],
    });
    await fixture.componentInstance.refresh();
    resolveOld?.({
      success: true,
      data: [{ name: 'old-key', label: 'Old key', purpose: '', createdAt: 1, updatedAt: 1, lastUsedAt: null }],
    });
    await oldRefresh;
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('new-key');
    expect(fixture.nativeElement.textContent).not.toContain('old-key');
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('keeps the secret list visible when audit history fails to load', async () => {
    ipc.listWorkspaceSecrets.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'example-key', label: 'Example key', purpose: '', createdAt: 1, updatedAt: 1, lastUsedAt: null }],
    });
    ipc.getWorkspaceSecretAudit.mockRejectedValueOnce(new Error('Audit unavailable'));
    const path = fixture.nativeElement.querySelector('.path-field input') as HTMLInputElement;
    path.value = '/example/workspace';
    path.dispatchEvent(new Event('input'));

    await fixture.componentInstance.refresh();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('example-key');
    expect(fixture.nativeElement.textContent).toContain('Audit unavailable');
  });
});
