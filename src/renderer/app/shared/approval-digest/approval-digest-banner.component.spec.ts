/**
 * N9 — the banner is a claim about what is blocked right now, so the cases that
 * matter are the ones where it must say NOTHING: no bridge, a failed poll, or
 * a cleared queue. A stale count implying sessions are still stuck is worse
 * than no banner.
 */
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalDigestBannerComponent } from './approval-digest-banner.component';
import { InstanceStore } from '../../core/state/instance.store';

await resolveComponentResources(() => Promise.resolve(''));

const DIGEST = {
  instances: 2,
  approvals: 3,
  oldestAgeMs: 3_600_000,
  oldestInstanceId: 'inst-oldest',
  title: 'Sessions are waiting for approval',
  body: '2 sessions are blocked on 3 approvals. The oldest has been waiting 1 hour.',
};

const setSelectedInstance = vi.fn();

function mount(api: unknown): ComponentFixture<ApprovalDigestBannerComponent> {
  (window as unknown as { electronAPI?: unknown }).electronAPI = api;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ApprovalDigestBannerComponent],
    providers: [{ provide: InstanceStore, useValue: { setSelectedInstance } }],
  });
  const fixture = TestBed.createComponent(ApprovalDigestBannerComponent);
  fixture.detectChanges();
  return fixture;
}

async function settle(fixture: ComponentFixture<ApprovalDigestBannerComponent>): Promise<void> {
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('ApprovalDigestBannerComponent (N9)', () => {
  beforeEach(() => setSelectedInstance.mockClear());

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  function banner(fixture: ComponentFixture<ApprovalDigestBannerComponent>): HTMLElement | null {
    return fixture.nativeElement.querySelector('.approval-digest');
  }

  it('says nothing when nothing is blocked', async () => {
    const fixture = mount({
      permissionGetApprovalDigest: vi.fn(async () => ({ success: true, data: { digest: null } })),
    });
    await settle(fixture);
    expect(banner(fixture)).toBeNull();
  });

  it('states the aggregate in main’s own words', async () => {
    const fixture = mount({
      permissionGetApprovalDigest: vi.fn(async () => ({ success: true, data: { digest: DIGEST } })),
    });
    await settle(fixture);
    expect(banner(fixture)?.textContent).toContain('2 sessions are blocked on 3 approvals');
    expect(banner(fixture)?.textContent).toContain('waiting 1 hour');
  });

  /**
   * These three must each start from a SHOWN banner and prove it clears.
   *
   * An earlier version asserted only that nothing rendered, which passed
   * whether or not the guard existed — the initial state is already null, so
   * the test could not tell "the guard cleared it" from "nothing happened".
   * Verified by disabling both guards and watching these go red.
   */
  async function shownThen(second: unknown): Promise<ComponentFixture<ApprovalDigestBannerComponent>> {
    const call = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { digest: DIGEST } })
      .mockImplementationOnce(second as () => Promise<unknown>);
    const fixture = mount({ permissionGetApprovalDigest: call });
    await settle(fixture);
    expect(banner(fixture), 'precondition: banner is showing').not.toBeNull();
    window.dispatchEvent(new Event('focus'));
    await settle(fixture);
    return fixture;
  }

  it('clears the banner when a later call fails', async () => {
    const fixture = await shownThen(async () => ({ success: false }));
    expect(banner(fixture)).toBeNull();
  });

  it('clears the banner when a later call throws, rather than leaving a stale count', async () => {
    const fixture = await shownThen(async () => { throw new Error('ipc down'); });
    expect(banner(fixture)).toBeNull();
  });

  /** No bridge means we cannot check the claim, so we must not make one. */
  it('renders nothing and does not throw when the preload bridge is absent', async () => {
    const fixture = mount({});
    await expect(settle(fixture)).resolves.toBeUndefined();
    expect(banner(fixture)).toBeNull();
  });

  it('clears a shown banner once the queue drains', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { digest: DIGEST } })
      .mockResolvedValueOnce({ success: true, data: { digest: null } });
    const fixture = mount({ permissionGetApprovalDigest: call });
    await settle(fixture);
    expect(banner(fixture)).not.toBeNull();

    window.dispatchEvent(new Event('focus'));
    await settle(fixture);
    expect(banner(fixture)).toBeNull();
  });

  it('re-checks on focus, because approvals arrive while you are away', async () => {
    const call = vi.fn(async () => ({ success: true, data: { digest: DIGEST } }));
    const fixture = mount({ permissionGetApprovalDigest: call });
    await settle(fixture);
    const before = call.mock.calls.length;

    window.dispatchEvent(new Event('focus'));
    await settle(fixture);
    expect(call.mock.calls.length).toBeGreaterThan(before);
  });

  it('jumps to the instance that has been waiting longest', async () => {
    const fixture = mount({
      permissionGetApprovalDigest: vi.fn(async () => ({ success: true, data: { digest: DIGEST } })),
    });
    await settle(fixture);
    (fixture.nativeElement.querySelector('.approval-digest__go') as HTMLButtonElement).click();
    expect(setSelectedInstance).toHaveBeenCalledWith('inst-oldest');
  });

  it('announces itself rather than only being drawn', async () => {
    const fixture = mount({
      permissionGetApprovalDigest: vi.fn(async () => ({ success: true, data: { digest: DIGEST } })),
    });
    await settle(fixture);
    expect(banner(fixture)?.getAttribute('role')).toBe('status');
  });

  it('stops polling once destroyed', async () => {
    vi.useFakeTimers();
    const call = vi.fn(async () => ({ success: true, data: { digest: null } }));
    const fixture = mount({ permissionGetApprovalDigest: call });
    fixture.destroy();
    const after = call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(call.mock.calls.length).toBe(after);
    vi.useRealTimers();
  });
});
