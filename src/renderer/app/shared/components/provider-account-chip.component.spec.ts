import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderAccountIpcService,
  type ProviderAccountRoutePreview,
  type ProviderAccountView,
} from '../../core/services/ipc/provider-account-ipc.service';
import { defaultProviderAccountPools } from '../../../../shared/types/provider-account.types';
import { ProviderAccountChipComponent } from './provider-account-chip.component';

function account(overrides: Partial<ProviderAccountView> = {}): ProviderAccountView {
  return {
    id: 'legacy',
    provider: 'claude',
    label: 'Max A',
    expectedIdentity: null,
    expectedAccountKey: null,
    planLabel: null,
    priority: 0,
    enabled: true,
    automationPolicy: 'allow-routed',
    isLegacy: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

let profiles: ProviderAccountView[];
let preview: ProviderAccountRoutePreview | null;
const ipc = {
  list: vi.fn(async () => ({ profiles, pools: defaultProviderAccountPools() })),
  previewRoute: vi.fn(async () => preview),
  switchSession: vi.fn(async () => ({ success: true })),
};

async function render(inputs: Record<string, unknown>): Promise<ComponentFixture<ProviderAccountChipComponent>> {
  const fixture = TestBed.createComponent(ProviderAccountChipComponent);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
  return fixture;
}

beforeEach(async () => {
  profiles = [account(), account({ id: 'max-b-1a2b', label: 'Max B', priority: 1, isLegacy: false })];
  preview = {
    outcome: { ok: true, route: { provider: 'claude', profileId: 'max-b-1a2b', source: 'default', executionNodeId: 'local', profileLabel: 'Max B' } },
    considered: [{ profileId: 'legacy', vetoReason: 'parked' }],
  };
  for (const spy of Object.values(ipc)) spy.mockClear();
  await TestBed.configureTestingModule({
    imports: [ProviderAccountChipComponent],
    providers: [{ provide: ProviderAccountIpcService, useValue: ipc }],
  }).compileComponents();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProviderAccountChipComponent', () => {
  it('renders nothing while only the existing sign-in exists', async () => {
    profiles = [account()];
    const fixture = await render({ provider: 'claude' });
    expect(fixture.nativeElement.querySelector('.provider-account-chip')).toBeNull();
    expect(ipc.previewRoute).not.toHaveBeenCalled();
  });

  it('renders nothing when the provider has only one enabled account', async () => {
    profiles = [account({ id: 'suas', label: 'Codex SUAS', isLegacy: false })];
    const fixture = await render({ provider: 'claude', mode: 'session', instanceId: 'inst-1' });
    expect(fixture.nativeElement.querySelector('.provider-account-chip')).toBeNull();
  });

  it('renders nothing when a second account is disabled', async () => {
    profiles = [account(), account({ id: 'max-b-1a2b', label: 'Max B', priority: 1, isLegacy: false, enabled: false })];
    const fixture = await render({ provider: 'claude', mode: 'session', instanceId: 'inst-1' });
    expect(fixture.nativeElement.querySelector('.provider-account-chip')).toBeNull();
  });

  it('renders nothing for providers without pools', async () => {
    const fixture = await render({ provider: 'gemini' });
    expect(fixture.nativeElement.querySelector('.provider-account-chip')).toBeNull();
    expect(ipc.list).not.toHaveBeenCalled();
  });

  it('explains why a draft skips an account at its limit', async () => {
    const fixture = await render({ provider: 'claude', model: 'opus' });
    expect(fixture.nativeElement.textContent).toContain('Max B · Max A is at its limit');
    expect(ipc.previewRoute).toHaveBeenCalledWith({ provider: 'claude', model: 'opus' });
  });

  it('previews for the worker node the draft targets', async () => {
    await render({ provider: 'claude', model: 'opus', executionNodeId: 'node-1' });
    expect(ipc.previewRoute).toHaveBeenLastCalledWith({ provider: 'claude', model: 'opus', executionNodeId: 'node-1' });
  });

  it('emits the account the user picks for a draft', async () => {
    const fixture = await render({ provider: 'claude' });
    const chosen: (string | null)[] = [];
    fixture.componentInstance.accountChosen.subscribe((value) => chosen.push(value));
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'max-b-1a2b';
    select.dispatchEvent(new Event('change'));
    expect(chosen).toEqual(['max-b-1a2b']);
  });

  it('clears a draft choice that is not one of this provider\'s accounts', async () => {
    const fixture = TestBed.createComponent(ProviderAccountChipComponent);
    const emitted: (string | null)[] = [];
    fixture.componentInstance.accountChosen.subscribe((value) => emitted.push(value));
    fixture.componentRef.setInput('provider', 'claude');
    fixture.componentRef.setInput('chosenProfileId', 'removed-account');
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitted).toEqual([null]);
    expect(ipc.previewRoute).not.toHaveBeenCalled();
  });

  it('switches a live session only after confirmation', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const fixture = await render({ provider: 'claude', mode: 'session', instanceId: 'inst-1', accountProfileId: 'legacy', accountRoutingSource: 'failover' });
    expect(fixture.nativeElement.querySelector('.text')?.textContent).toBe('Max A');
    expect(fixture.nativeElement.textContent).not.toContain('moved here at a usage limit');
    expect(fixture.nativeElement.textContent).not.toContain('the account this conversation runs on');
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'max-b-1a2b';
    await fixture.componentInstance.onSelect({ target: select } as unknown as Event);
    expect(ipc.switchSession).not.toHaveBeenCalled();
    expect(select.value).toBe('legacy');

    confirm.mockReturnValue(true);
    select.value = 'max-b-1a2b';
    await fixture.componentInstance.onSelect({ target: select } as unknown as Event);
    expect(ipc.switchSession).toHaveBeenCalledWith('inst-1', 'max-b-1a2b');
  });

  it('ignores an older preview that resolves after a newer one', async () => {
    let releaseSlow: (value: ProviderAccountRoutePreview | null) => void = () => undefined;
    const slow = new Promise<ProviderAccountRoutePreview | null>((resolve) => { releaseSlow = resolve; });
    const fresh: ProviderAccountRoutePreview = {
      outcome: { ok: true, route: { provider: 'claude', profileId: 'legacy', source: 'explicit', executionNodeId: 'local', profileLabel: 'Max A' } },
      considered: [],
    };
    ipc.previewRoute.mockImplementationOnce(() => slow).mockImplementationOnce(async () => fresh);
    const fixture = await render({ provider: 'claude', model: 'opus' });
    fixture.componentRef.setInput('model', 'sonnet');
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();
    }
    releaseSlow(preview);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Max A · you chose this account');
  });

  it('shows why a draft cannot start', async () => {
    preview = { outcome: { ok: false, code: 'all-profiles-parked', detail: 'Every Claude account is at its limit.' }, considered: [] };
    const fixture = await render({ provider: 'claude' });
    expect(fixture.nativeElement.textContent).toContain('Every Claude account is at its limit.');
  });
});
