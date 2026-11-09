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

  it('shows the tool name beside Approve, and keeps only the key-value details under Details', async () => {
    const fixture = setup([makeItem()]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    // Someone who approves must be able to see which tool they are approving, without opening anything.
    const row = element.querySelector('.approval-row')!;
    const details = element.querySelector('details.approval-more');
    expect(element.querySelector('.approval-meta')?.textContent).toContain('computer.request_app_grant');
    expect(row.querySelector('.approval-actions .primary')).not.toBeNull();
    expect(details?.textContent).not.toContain('computer.request_app_grant');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('summary')?.textContent?.trim()).toBe('Details');
    expect(details?.textContent).toContain('appId: com.apple.calculator');
    expect(element.querySelector('.approval-copy-top')?.textContent).not.toContain('appId');
    expect(element.querySelector('[title]')).toBeNull();
  });

  it('shows the tool name even when there are no key-value details to fold away', async () => {
    const fixture = setup([makeItem({ details: undefined })]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.approval-meta')?.textContent).toContain('computer.request_app_grant');
    expect(element.querySelector('details.approval-more')).toBeNull();
  });

  it.each([
    ['store_release_mutation', undefined, 'Allow this once', 'Lasts just this once.'],
    ['calendar_mutation', undefined, 'Allow this once', 'Lasts just this once.'],
    ['desktop_computer_use_grant', { duration: 'session' }, 'Allow for this session',
      'Lasts until this session ends, and no longer than an hour.'],
    ['desktop_computer_use_grant', { duration: 'boundedMinutes', minutes: 30 }, 'Allow for 30 minutes',
      'Lasts for 30 minutes, in this session only.'],
    ['desktop_computer_use_grant', { duration: 'untilRevoked' }, 'Always allow',
      'Lasts until you take it back, in every session.'],
  ])('%s %j: the button and the "lasts" line say how long an approval stands', async (action, details, button, lasts) => {
    const fixture = setup([makeItem({ action, details })]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.banner-btn.primary')?.textContent?.trim()).toBe(button);
    expect(element.querySelector('.approval-lasts')?.textContent?.trim()).toBe(lasts);
  });

  it('offers "Always allow" with what it covers, and sends that choice', async () => {
    const covers = 'Always allow means no session asks again before it sends mail from person@example.test.';
    const fixture = setup([makeItem({ action: 'microsoft365_mutation', alwaysAllowCovers: covers })]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.banner-btn.primary')?.textContent?.trim()).toBe('Allow this once');
    expect(element.querySelector('.approval-always')?.textContent?.trim()).toBe(covers);
    const always = element.querySelector<HTMLButtonElement>('.banner-btn.always');
    expect(always?.textContent?.trim()).toBe('Always allow');
    always?.click();
    await fixture.whenStable();

    expect(service.resolve).toHaveBeenCalledWith('grant_1', true, expect.any(String), true);
  });

  it('offers no "Always allow" when the request cannot remember a yes', async () => {
    const fixture = setup([makeItem({ action: 'microsoft365_mutation' })]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.banner-btn.always')).toBeNull();
    expect(element.querySelector('.approval-always')).toBeNull();
  });

  it('keeps the plain Approve button and makes no promise when it cannot tell how long an approval stands', async () => {
    const fixture = setup([makeItem()]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.banner-btn.primary')?.textContent?.trim()).toBe('Approve');
    expect(element.querySelector('.approval-lasts')).toBeNull();
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

    expect(service.resolve).toHaveBeenCalledWith('grant_1', true, expect.any(String), false);
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

    expect(service.resolve).toHaveBeenCalledWith('grant_1', false, expect.any(String), false);
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
