import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityIpcService } from '../../core/services/ipc/security-ipc.service';
import { SavedPermissionDecisionsComponent, summarizeRule } from './saved-permission-decisions.component';
import type { SavedPermissionRule } from '../../../../shared/types/saved-permission-rule.types';

const rule: SavedPermissionRule = { id: 'rule-1', action: 'deny', scope: 'tool_use', pattern: 'bash:echo hello', literal: false, enabled: true, createdAt: 1_800_000_000_000 };
describe('saved permission decisions', () => {
  beforeEach(() => TestBed.resetTestingModule());
  it('summarizes shell, file and tool rules', () => {
    expect(summarizeRule({ ...rule, scope: 'bash_execute' })).toBe('Shell command: echo hello');
    expect(summarizeRule({ ...rule, scope: 'file_write', pattern: '/tmp/file' })).toBe('File: /tmp/file');
    expect(summarizeRule({ ...rule, pattern: 'tool:WebFetch' })).toBe('Tool: WebFetch');
  });
  it('renders blocks and old formats and removes then reloads into the empty state', async () => {
    const ipc = { permissionListUserRules: vi.fn().mockResolvedValueOnce({ success: true, data: [rule] }).mockResolvedValue({ success: true, data: [] }),
      permissionRemoveUserRule: vi.fn(async () => ({ success: true, data: true })) };
    await TestBed.configureTestingModule({ imports: [SavedPermissionDecisionsComponent], providers: [{ provide: SecurityIpcService, useValue: ipc }] }).compileComponents();
    const fixture = TestBed.createComponent(SavedPermissionDecisionsComponent); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Block');
    expect(fixture.nativeElement.textContent).toContain('Refuses without asking');
    expect(fixture.nativeElement.textContent).toContain('Older format; no longer used');
    const remove = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(remove.getAttribute('aria-label')).toBe('Remove saved decision: Tool: bash:echo hello');
    remove.click(); await fixture.whenStable(); fixture.detectChanges();
    expect(ipc.permissionRemoveUserRule).toHaveBeenCalledWith('rule-1');
    expect(ipc.permissionListUserRules).toHaveBeenCalledTimes(2);
    expect(fixture.nativeElement.textContent).toContain('Nothing saved yet.');
    expect(fixture.nativeElement.textContent).toContain('Removed. Harness will ask again.');
  });
});
