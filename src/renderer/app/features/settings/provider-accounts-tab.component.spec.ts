import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderAccountIpcService,
  type ProviderAccountDoctorView,
  type ProviderAccountView,
} from '../../core/services/ipc/provider-account-ipc.service';
import { defaultProviderAccountPools, type ProviderAccountPools } from '../../../../shared/types/provider-account.types';
import { ProviderAccountsTabComponent } from './provider-accounts-tab.component';

function account(overrides: Partial<ProviderAccountView> = {}): ProviderAccountView {
  return {
    id: 'legacy',
    provider: 'claude',
    label: 'Existing Claude account',
    expectedIdentity: 'a@example.com',
    expectedAccountKey: null,
    planLabel: 'max',
    priority: 0,
    enabled: true,
    automationPolicy: 'allow-routed',
    isLegacy: true,
    createdAt: 1,
    updatedAt: 1,
    binding: { nodeId: 'local', state: 'authenticated', observedIdentity: 'a@example.com', checkedAt: 1 },
    ...overrides,
  };
}

interface MutationResult {
  success: boolean;
  data?: unknown;
  error?: { message?: string };
}

let pools: ProviderAccountPools;
const ipc = {
  list: vi.fn(async () => ({ profiles: [account(), account({ id: 'max-b-1a2b', label: 'Max B', priority: 1, isLegacy: false, enabled: false, binding: { nodeId: 'local', state: 'unauthenticated' as const, checkedAt: 1 } })], pools })),
  doctor: vi.fn(async (): Promise<ProviderAccountDoctorView | null> => null),
  create: vi.fn(async (): Promise<MutationResult> => ({ success: true, data: account({ id: 'max-c-1a2b', label: 'Max C', isLegacy: false }) })),
  update: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  setPriorityOrder: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  remove: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  verify: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  launchLogin: vi.fn(async (): Promise<MutationResult> => ({ success: true, data: { terminal: 'Terminal' } })),
  updatePool: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  acknowledgeOwnership: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
};

async function settle(fixture: ComponentFixture<ProviderAccountsTabComponent>): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
}

async function render(): Promise<ComponentFixture<ProviderAccountsTabComponent>> {
  const fixture = TestBed.createComponent(ProviderAccountsTabComponent);
  fixture.detectChanges();
  await settle(fixture);
  return fixture;
}

function claudeSection(fixture: ComponentFixture<ProviderAccountsTabComponent>): HTMLElement {
  return fixture.nativeElement.querySelector('[data-provider="claude"]') as HTMLElement;
}

beforeEach(async () => {
  pools = defaultProviderAccountPools();
  for (const spy of Object.values(ipc)) spy.mockClear();
  await TestBed.configureTestingModule({
    imports: [ProviderAccountsTabComponent],
    providers: [{ provide: ProviderAccountIpcService, useValue: ipc }],
  }).compileComponents();
});

describe('ProviderAccountsTabComponent', () => {
  it('shows each Claude account in priority order with identity, plan and sign-in state', async () => {
    const fixture = await render();
    const section = claudeSection(fixture);
    const titles = Array.from(section.querySelectorAll('.account-title strong')).map((node) => node.textContent?.trim());
    expect(titles).toEqual(['Existing Claude account', 'Max B']);
    expect(section.textContent).toContain('Signed in as a@example.com');
    expect(section.textContent).toContain('Not signed in');
    expect(section.textContent).toContain('max');
    expect(fixture.nativeElement.textContent).not.toMatch(/(claude|codex)-cli-profiles/);
  });

  it('marks the first enabled account as the default, skipping a disabled one', async () => {
    const original = ipc.list.getMockImplementation();
    ipc.list.mockImplementation(async () => ({
      profiles: [
        account({ enabled: false }),
        account({ id: 'max-b-1a2b', label: 'Max B', priority: 1, isLegacy: false, enabled: true }),
      ],
      pools,
    }));
    try {
      const fixture = await render();
      const cards = Array.from(claudeSection(fixture).querySelectorAll('.account-card'));
      expect(cards.map((card) => Boolean(card.querySelector('.chip.default')))).toEqual([false, true]);
    } finally {
      if (original) ipc.list.mockImplementation(original);
    }
  });

  it('keeps polling after a sign-in check fails, then reports the account signed in', async () => {
    const fixture = await render();
    vi.useFakeTimers();
    try {
      ipc.verify
        .mockImplementationOnce(async () => { throw new Error('ipc closed'); })
        .mockImplementationOnce(async () => ({ success: true, data: account({ id: 'max-c-1a2b', label: 'Max C', isLegacy: false }) }));
      fixture.componentInstance.setNewLabel('claude', 'Max C');
      await fixture.componentInstance.addAccount('claude');
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ipc.verify).toHaveBeenCalledTimes(2);
      expect(fixture.componentInstance.notice()).toBe('"Max C" is signed in.');
    } finally {
      vi.useRealTimers();
      fixture.destroy();
    }
  });

  it('never lets a failed sign-in check reject out of the poll tick', async () => {
    const fixture = await render();
    ipc.verify.mockImplementationOnce(async () => { throw new Error('ipc closed'); });
    const tick = (fixture.componentInstance as unknown as { checkSignIn(view: ProviderAccountView): Promise<void> })
      .checkSignIn(account({ id: 'max-c-1a2b', label: 'Max C', isLegacy: false }));
    await expect(tick).resolves.toBeUndefined();
    fixture.destroy();
  });

  it('adds an account and copies its sign-in command instead of opening a terminal', async () => {
    const fixture = await render();
    fixture.componentInstance.setNewLabel('claude', 'Max C');
    await fixture.componentInstance.addAccount('claude');
    expect(ipc.create).toHaveBeenCalledWith({ provider: 'claude', label: 'Max C' });
    expect(ipc.launchLogin).toHaveBeenCalledWith('claude', 'max-c-1a2b', undefined);
    expect(fixture.componentInstance.notice()).toContain('Paste it in your own terminal');
    fixture.destroy();
  });

  it('opens a Harness terminal only from the explicit button', async () => {
    const fixture = await render();
    await fixture.componentInstance.signIn(account({ id: 'max-b-1a2b', label: 'Max B', isLegacy: false }), true);
    expect(ipc.launchLogin).toHaveBeenCalledWith('claude', 'max-b-1a2b', { openTerminal: true });
    expect(fixture.componentInstance.notice()).toContain('Opened a terminal');
    fixture.destroy();
  });

  it('asks for the ownership acknowledgement until it is given', async () => {
    const fixture = await render();
    expect(claudeSection(fixture).textContent).toContain('I confirm these are my own accounts');
    const button = Array.from(claudeSection(fixture).querySelectorAll('button')).find((node) => node.textContent?.includes('I confirm'))!;
    button.click();
    await settle(fixture);
    expect(ipc.acknowledgeOwnership).toHaveBeenCalledWith('claude');
  });

  it('moves an account up by sending the full new order', async () => {
    const fixture = await render();
    const second = fixture.componentInstance.accountsFor('claude')[1]!;
    await fixture.componentInstance.move(second, -1);
    expect(ipc.setPriorityOrder).toHaveBeenCalledWith('claude', ['max-b-1a2b', 'legacy']);
  });

  it('surfaces a failed change as an error, not silently', async () => {
    ipc.update.mockResolvedValueOnce({ success: false, error: { message: 'Confirm that every Claude account is yours first.' } });
    const fixture = await render();
    await fixture.componentInstance.setEnabled(fixture.componentInstance.accountsFor('claude')[1]!, true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.error-banner')?.textContent).toContain('Confirm that every Claude account');
  });
});
