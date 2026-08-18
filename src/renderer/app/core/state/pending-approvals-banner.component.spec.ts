import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingApprovalItem } from '../../../../shared/types/permission-registry.types';
import { PendingApprovalsBannerComponent } from './pending-approvals-banner.component';
import { PermissionRegistryIpcService } from '../services/ipc/permission-registry-ipc.service';

function makeItem(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return {
    id: 'grant_1',
    instanceId: 'inst-1',
    instanceLabel: 'My Claude Session',
    instanceProvider: 'claude',
    action: 'desktop_computer_use_grant',
    description: 'Allow Computer Use observeAndInput for Calculator',
    toolName: 'computer.request_app_grant',
    details: { appId: 'com.apple.calculator', capability: 'observeAndInput' },
    createdAt: 1_000,
    timeoutMs: 60_000,
    expiresAt: 61_000,
    ...overrides,
  };
}

function makeService(items: PendingApprovalItem[]) {
  return {
    listPending: vi.fn(async () => ({ success: true as const, data: items })),
    resolve: vi.fn(async () => ({ success: true as const, data: { requestId: items[0]?.id ?? '', granted: true } })),
    extend: vi.fn(async () => ({ success: true as const, data: items[0] })),
  };
}

describe('PendingApprovalsBannerComponent', () => {
  let service: ReturnType<typeof makeService>;

  function setup(items: PendingApprovalItem[]) {
    TestBed.resetTestingModule();
    service = makeService(items);
    TestBed.configureTestingModule({
      imports: [PendingApprovalsBannerComponent],
      providers: [{ provide: PermissionRegistryIpcService, useValue: service }],
    });
    const fixture = TestBed.createComponent(PendingApprovalsBannerComponent);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stays hidden when nothing is pending', async () => {
    const fixture = setup([]);
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.approvals-banner')).toBeNull();
  });

  it('renders context (instance, description, tool, risk badge) for a pending Computer Use grant', async () => {
    const fixture = setup([makeItem()]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    const banner = element.querySelector('.approvals-banner');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.textContent).toContain('Approval needed');
    expect(banner?.textContent).toContain('Desktop app access (Computer Use)');
    expect(banner?.textContent).toContain('Allow Computer Use observeAndInput for Calculator');
    expect(banner?.textContent).toContain('My Claude Session');
    expect(banner?.textContent).toContain('claude');
    expect(banner?.textContent).toContain('computer.request_app_grant');
    expect(banner?.textContent).toContain('appId: com.apple.calculator');
  });

  it('marks a store-release request as critical risk', async () => {
    const fixture = setup([makeItem({
      action: 'store_release_mutation',
      description: 'Allow App Store Connect release for com.acme.app (42) to production?',
    })]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.status-dot.critical')).not.toBeNull();
    expect(element.querySelector('.risk-badge.tier-critical')?.textContent).toContain('Public app store release');
  });

  it('Approve calls resolve(id, true) — the reachable end-to-end path the defect lacked', async () => {
    const fixture = setup([makeItem()]);
    await fixture.whenStable();
    fixture.detectChanges();

    const approveButton = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('.banner-btn.primary');
    approveButton?.click();
    await fixture.whenStable();

    expect(service.resolve).toHaveBeenCalledWith('grant_1', true, expect.any(String));
  });

  it('Deny calls resolve(id, false)', async () => {
    const fixture = setup([makeItem()]);
    await fixture.whenStable();
    fixture.detectChanges();

    const denyButton = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.banner-btn'),
    ).find((button) => button.textContent?.trim() === 'Deny');
    denyButton?.click();
    await fixture.whenStable();

    expect(service.resolve).toHaveBeenCalledWith('grant_1', false, expect.any(String));
  });

  it('Extend calls extend(id, 2 minutes) for the short Computer Use window', async () => {
    const fixture = setup([makeItem()]);
    await fixture.whenStable();
    fixture.detectChanges();

    const extendButton = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.banner-btn'),
    ).find((button) => button.textContent?.trim() === '+2 min');
    extendButton?.click();
    await fixture.whenStable();

    expect(service.extend).toHaveBeenCalledWith('grant_1', 120_000);
  });

  it('polls listPending on an interval without instance scoping (app-wide surface)', () => {
    setup([]);
    expect(service.listPending).toHaveBeenCalledWith();
  });
});
