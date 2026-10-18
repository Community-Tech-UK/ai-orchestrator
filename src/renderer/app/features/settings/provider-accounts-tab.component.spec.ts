import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderAccountIpcService,
  type ProviderAccountDoctorView,
  type ProviderAccountView,
} from '../../core/services/ipc/provider-account-ipc.service';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { defaultProviderAccountPools, type ProviderAccountPools } from '../../../../shared/types/provider-account.types';
import { ProviderAccountsTabComponent } from './provider-accounts-tab.component';
import { RemoteNodeStore } from '../../core/state/remote-node.store';

const template = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), './provider-accounts-tab.component.html'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('provider-accounts-tab.component.html')) return Promise.resolve(template);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

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

/** Deterministic worker roster for the per-machine MiMo rows. */
let connectedNodesValue: { id: string; name: string; capabilities: { accountProfileIds?: { opencode?: string[] } } }[] = [];

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
  quotaSession: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  updatePool: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  acknowledgeOwnership: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
};

/** Sign-in for providers that have no account list on this page. */
const providerIpc = {
  runProviderLogin: vi.fn(async (): Promise<MutationResult> => ({
    success: true,
    data: { terminal: 'Terminal', command: 'grok login' },
  })),
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
  connectedNodesValue = [];
  for (const spy of Object.values(ipc)) spy.mockClear();
  providerIpc.runProviderLogin.mockClear();
  providerIpc.runProviderLogin.mockResolvedValue({ success: true, data: { terminal: 'Terminal', command: 'grok login' } });
  await TestBed.configureTestingModule({
    imports: [ProviderAccountsTabComponent],
    providers: [
      { provide: ProviderAccountIpcService, useValue: ipc },
      { provide: ProviderIpcService, useValue: providerIpc },
      // Deterministic worker roster: the per-machine MiMo rows read it.
      { provide: RemoteNodeStore, useValue: { connectedNodes: () => connectedNodesValue } },
    ],
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

  it('shows a global error when a newly created account’s sign-in command cannot be copied before its card loads', async () => {
    const fixture = await render();
    try {
      ipc.launchLogin.mockResolvedValueOnce({ success: false, error: { message: 'Sign-in command could not be copied.' } });
      fixture.componentInstance.setNewLabel('claude', 'Max C');
      await fixture.componentInstance.addAccount('claude');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.provider-accounts-tab > [role="alert"]')?.textContent)
        .toContain('Sign-in command could not be copied.');
      expect(fixture.nativeElement.querySelector('[role="status"]')).toBeNull();
    } finally {
      fixture.destroy();
    }
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

  it('hides reordering and switching rules until a provider has a second account', async () => {
    const original = ipc.list.getMockImplementation();
    ipc.list.mockImplementation(async () => ({ profiles: [account()], pools }));
    try {
      const section = claudeSection(await render());
      expect(section.querySelector('[aria-label^="Move "]')).toBeNull();
      expect(section.querySelector('.pool-policy')).toBeNull();
      expect(section.textContent).not.toContain('I confirm these are my own accounts');
      expect(section.textContent).toContain('Add a second Claude account');
    } finally {
      if (original) ipc.list.mockImplementation(original);
    }
  });

  it('locks the Enabled toggle on the only enabled account', async () => {
    const section = claudeSection(await render());
    const toggles = Array.from(section.querySelectorAll<HTMLInputElement>('.account-card input[type="checkbox"]'));
    expect(toggles.map((toggle) => toggle.disabled)).toEqual([true, false]);
  });

  it('leads with the Sign in button only for an account that is not signed in', async () => {
    const section = claudeSection(await render());
    const cards = Array.from(section.querySelectorAll('.account-card'));
    const primaries = cards.map(
      (card) => card.querySelector('.btn-primary')?.textContent?.trim() ?? null,
    );
    expect(primaries).toEqual([null, 'Sign in']);
    // The copy-to-clipboard command stays available, just not as the lead action.
    expect(cards[1]!.textContent).toContain('Copy sign-in command');
  });

  it('still names the expected email on an account that is signed out', async () => {
    const statuses = Array.from(claudeSection(await render()).querySelectorAll('.account-card .status'))
      .map((node) => node.textContent?.replace(/\s+/g, ' ').trim());
    expect(statuses).toEqual(['Signed in as a@example.com', 'Not signed in · a@example.com']);
  });

  it('adds an account when Enter is pressed in the name field', async () => {
    const fixture = await render();
    const input = claudeSection(fixture).querySelector<HTMLInputElement>('.add-row input')!;
    input.value = 'Work';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(fixture);
    expect(ipc.create).toHaveBeenCalledWith({ provider: 'claude', label: 'Work' });
    fixture.destroy();
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

  it('renames an account through the in-app modal instead of the no-op window.prompt', async () => {
    const fixture = await render();
    const target = fixture.componentInstance.accountsFor('claude')[0]!;
    fixture.componentInstance.rename(target);
    fixture.detectChanges();
    expect(fixture.componentInstance.renameModalOpen()).toBe(true);
    expect(fixture.componentInstance.renameInitial()).toBe(target.label);

    await fixture.componentInstance.onRenameSubmitted('Renamed Claude account');
    expect(ipc.update).toHaveBeenCalledWith({ provider: 'claude', profileId: target.id, label: 'Renamed Claude account' });
    expect(fixture.componentInstance.renameModalOpen()).toBe(false);
  });

  it('does not call the IPC on rename cancel or an unchanged/blank name', async () => {
    const fixture = await render();
    const target = fixture.componentInstance.accountsFor('claude')[0]!;

    fixture.componentInstance.rename(target);
    fixture.componentInstance.onRenameCancelled();
    expect(ipc.update).not.toHaveBeenCalled();

    fixture.componentInstance.rename(target);
    await fixture.componentInstance.onRenameSubmitted(target.label);
    expect(ipc.update).not.toHaveBeenCalled();
  });
});

describe('ProviderAccountsTabComponent — MiMo accounts', () => {
  function mimoAccount(overrides: Partial<ProviderAccountView> = {}): ProviderAccountView {
    return account({
      id: 'max-b-1a2b',
      provider: 'opencode',
      label: 'MiMo B',
      isLegacy: false,
      region: 'ams',
      expectedIdentity: null,
      binding: { nodeId: 'local', state: 'authenticated', checkedAt: 1 },
      ...overrides,
    });
  }

  function opencodeSection(fixture: ComponentFixture<ProviderAccountsTabComponent>): HTMLElement {
    return fixture.nativeElement.querySelector('[data-provider="opencode"]') as HTMLElement;
  }

  it('distinguishes coding sign-in from missing usage access and reports copying inside the right account', async () => {
    const original = ipc.list.getMockImplementation();
    ipc.list.mockImplementation(async () => ({ profiles: [account(), mimoAccount({ id: 'legacy', isLegacy: true })], pools }));
    let fixture: ComponentFixture<ProviderAccountsTabComponent> | undefined;
    try {
      fixture = await render();
      const card = opencodeSection(fixture).querySelector<HTMLElement>('.account-card')!;
      expect(card.textContent).toContain('Coding sign-in:');
      expect(card.textContent).toContain('No saved usage login');
      const copy = Array.from(card.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Copy coding sign-in command')!;
      expect(copy).toBeDefined();
      copy.click();
      await settle(fixture);
      expect(ipc.launchLogin).toHaveBeenCalledExactlyOnceWith('opencode', 'legacy', undefined);
      expect(ipc.quotaSession).not.toHaveBeenCalled();
      expect(card.querySelector('[role="status"]')?.textContent).toContain('Paste it in your own terminal');
      expect(claudeSection(fixture).querySelector('[role="status"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('.provider-accounts-tab > [role="status"]')).toBeNull();
    } finally {
      fixture?.destroy();
      if (original) ipc.list.mockImplementation(original);
    }
  });

  it('places usage login failures in the clicked account and clears an earlier copying notice', async () => {
    const original = ipc.list.getMockImplementation();
    ipc.list.mockImplementation(async () => ({ profiles: [mimoAccount({ id: 'legacy', isLegacy: true }), mimoAccount({ priority: 1 })], pools }));
    let fixture: ComponentFixture<ProviderAccountsTabComponent> | undefined;
    try {
      fixture = await render();
      await fixture.componentInstance.signIn(fixture.componentInstance.accountsFor('opencode')[0]!);
      ipc.quotaSession.mockResolvedValueOnce({ success: false, error: { message: 'Secure session storage is unavailable.' } });
      const cards = opencodeSection(fixture).querySelectorAll<HTMLElement>('.account-card');
      Array.from(cards[1]!.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Connect usage')!.click();
      await settle(fixture);
      expect(cards[1]!.querySelector('[role="alert"]')?.textContent).toContain('Secure session storage is unavailable.');
      expect(cards[0]!.querySelector('[role="alert"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[role="status"]')).toBeNull();
    } finally {
      fixture?.destroy();
      if (original) ipc.list.mockImplementation(original);
    }
  });

  it('keeps Xiaomi instructions when usage sign-in follows copying a coding command', async () => {
    const fixture = await render();
    vi.useFakeTimers();
    try {
      const profile = mimoAccount();
      await fixture.componentInstance.signIn(profile);
      await fixture.componentInstance.manageUsageSession(profile, 'connect');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ipc.verify).not.toHaveBeenCalled();
      expect(fixture.componentInstance.notice()).toContain('Xiaomi sign-in window');
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it('ignores an older in-flight coding check without stopping the newer account’s sign-in poll', async () => {
    const fixture = await render();
    vi.useFakeTimers();
    try {
      const first = mimoAccount();
      const second = mimoAccount({ id: 'synthetic-next', label: 'Next MiMo' });
      let finishOldCheck: (result: MutationResult) => void = () => { throw new Error('Old check did not start'); };
      ipc.verify
        .mockImplementationOnce(() => new Promise(resolve => { finishOldCheck = resolve; }))
        .mockResolvedValueOnce({ success: true, data: second });
      await fixture.componentInstance.signIn(first);
      await vi.advanceTimersByTimeAsync(5_000);
      await fixture.componentInstance.signIn(second);
      finishOldCheck({ success: true, data: first });
      await Promise.resolve();
      expect(fixture.componentInstance.notice()).toContain('Sign-in command copied for "Next MiMo"');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ipc.verify).toHaveBeenCalledTimes(2);
      expect(fixture.componentInstance.notice()).toBe('"Next MiMo" is signed in.');
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it('connects usage independently of CLI sign-in and refreshes the saved connection state', async () => {
    const original = ipc.list.getMockImplementation();
    let connected = false;
    ipc.list.mockImplementation(async () => ({ profiles: [mimoAccount({ quotaSessionConnected: connected })], pools }));
    let fixture: ComponentFixture<ProviderAccountsTabComponent> | undefined;
    try {
      fixture = await render();
      const connect = Array.from(opencodeSection(fixture).querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Connect usage');
      expect(connect).toBeDefined();
      connect!.click();
      await settle(fixture);
      expect(ipc.quotaSession).toHaveBeenCalledExactlyOnceWith('max-b-1a2b', 'connect');
      expect(ipc.launchLogin).not.toHaveBeenCalled();
      expect(fixture.componentInstance.notice()).toContain('Xiaomi sign-in window');
      expect(fixture.componentInstance.notice()).toContain('Refresh');
      expect(opencodeSection(fixture).querySelector('.account-card [role="status"]')?.textContent).toContain('Xiaomi sign-in window');
      connected = true;
      fixture.nativeElement.querySelector('.tab-intro button').click();
      await settle(fixture);
      expect(opencodeSection(fixture).textContent).toContain('Usage session saved');
      expect(opencodeSection(fixture).textContent).toContain('Sign in to usage again');
      expect(opencodeSection(fixture).textContent).toContain('Disconnect usage');
    } finally {
      fixture?.destroy();
      if (original) ipc.list.mockImplementation(original);
    }
  });

  it('disconnects saved usage access and exposes the reconnect control', async () => {
    const original = ipc.list.getMockImplementation();
    ipc.list.mockImplementationOnce(async () => ({ profiles: [mimoAccount({ quotaSessionConnected: true })], pools }));
    ipc.list.mockImplementation(async () => ({ profiles: [mimoAccount({ quotaSessionConnected: false })], pools }));
    let fixture: ComponentFixture<ProviderAccountsTabComponent> | undefined;
    try {
      fixture = await render();
      const disconnect = Array.from(opencodeSection(fixture).querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Disconnect usage');
      expect(disconnect).toBeDefined();
      disconnect!.click();
      await settle(fixture);
      expect(ipc.quotaSession).toHaveBeenCalledExactlyOnceWith('max-b-1a2b', 'disconnect');
      expect(opencodeSection(fixture).textContent).toContain('Connect usage');
      expect(opencodeSection(fixture).textContent).not.toContain('Disconnect usage');
      expect(fixture.componentInstance.notice()).toContain('Saved usage login removed');
    } finally {
      fixture?.destroy();
      if (original) ipc.list.mockImplementation(original);
    }
  });

  it('shows usage connection failures without reporting that a sign-in window opened', async () => {
    const original = ipc.list.getMockImplementation();
    ipc.list.mockImplementation(async () => ({ profiles: [mimoAccount()], pools }));
    ipc.quotaSession.mockResolvedValueOnce({ success: false, error: { message: 'Secure session storage is unavailable.' } });
    let fixture: ComponentFixture<ProviderAccountsTabComponent> | undefined;
    try {
      fixture = await render();
      const connect = Array.from(opencodeSection(fixture).querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Connect usage');
      expect(connect).toBeDefined();
      connect!.click();
      await settle(fixture);
      expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain('Secure session storage is unavailable.');
      expect(fixture.nativeElement.querySelector('[role="status"]')).toBeNull();
    } finally {
      fixture?.destroy();
      if (original) ipc.list.mockImplementation(original);
    }
  });

  it('describes the MiMo allowance separately and saves its rendered switching threshold', async () => {
    const original = ipc.list.getMockImplementation();
    ipc.list.mockImplementation(async () => ({
      profiles: [
        ...(['claude', 'codex'] as const).flatMap((provider) => [
          account({ provider }),
          account({ provider, id: 'synthetic-b', isLegacy: false, priority: 1 }),
        ]),
        mimoAccount({ id: 'legacy', isLegacy: true, priority: 0 }),
        mimoAccount({ priority: 1 }),
      ],
      pools,
    }));
    let fixture: ComponentFixture<ProviderAccountsTabComponent> | undefined;
    try {
      fixture = await render();
      const policy = opencodeSection(fixture).querySelector<HTMLElement>('.early-switch')!;
      expect(policy.textContent).toContain('usage allowance');
      expect(policy.textContent).not.toContain('5-hour usage');
      for (const provider of ['claude', 'codex']) {
        const otherPolicy = fixture.nativeElement.querySelector(`[data-provider="${provider}"] .early-switch`);
        expect(otherPolicy.textContent).toContain('5-hour usage');
        expect(otherPolicy.textContent).not.toContain('usage allowance');
      }
      const threshold = policy.querySelector<HTMLInputElement>('input[type="number"]')!;
      expect(threshold.value).toBe('90');
      threshold.value = '95';
      threshold.dispatchEvent(new Event('change'));
      await settle(fixture);
      expect(ipc.updatePool).toHaveBeenCalledWith({ provider: 'opencode', preemptive: { thresholdPct: 95 } });
    } finally {
      fixture?.destroy();
      if (original) ipc.list.mockImplementation(original);
    }
  });

  it('creates a MiMo account with its Token Plan region and Chrome profile', async () => {
    const fixture = await render();
    fixture.componentInstance.setNewLabel('opencode', 'MiMo B');
    fixture.componentInstance.setNewRegion('opencode', 'sgp');
    fixture.componentInstance.setNewChromeProfile('opencode', 'Profile 1');
    await fixture.componentInstance.addAccount('opencode');
    expect(ipc.create).toHaveBeenCalledWith({
      provider: 'opencode',
      label: 'MiMo B',
      region: 'sgp',
      chromeProfile: 'Profile 1',
    });
    fixture.destroy();
  });

  it('omits the Chrome profile when none is given and defaults the region to Europe', async () => {
    const fixture = await render();
    fixture.componentInstance.setNewLabel('opencode', 'MiMo C');
    await fixture.componentInstance.addAccount('opencode');
    expect(ipc.create).toHaveBeenCalledWith({ provider: 'opencode', label: 'MiMo C', region: 'ams' });
    fixture.destroy();
  });

  it('shows each machine’s MiMo sign-in and the exact command for one missing it', async () => {
    const original = ipc.list.getMockImplementation();
    ipc.list.mockImplementation(async () => ({ profiles: [mimoAccount()], pools }));
    connectedNodesValue = [
      { id: 'node-a', name: 'windows-pc', capabilities: { accountProfileIds: { opencode: ['max-b-1a2b'] } } },
      { id: 'node-b', name: 'noahlaptop', capabilities: {} },
    ];
    try {
      const fixture = await render();
      const section = opencodeSection(fixture);
      expect(section.textContent).toContain('windows-pc');
      expect(section.textContent).toContain('Signed in on that machine');
      expect(section.textContent).toContain('noahlaptop');
      expect(section.textContent).toContain('node -e');
      fixture.destroy();
    } finally {
      if (original) ipc.list.mockImplementation(original);
      connectedNodesValue = [];
    }
  });

  it.each(['missing', 'denied', 'success'] as const)(
    'reports the actual clipboard result when the remote Copy button is %s', async (mode) => {
      const original = ipc.list.getMockImplementation();
      const priorClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      const profile = mimoAccount();
      ipc.list.mockImplementation(async () => ({ profiles: [profile], pools }));
      connectedNodesValue = [{ id: 'node-b', name: 'windows-pc', capabilities: {} }];
      let finishCopy: () => void = () => { throw new Error('Clipboard write was not started'); };
      const writeText = vi.fn(() => mode === 'denied'
        ? Promise.reject(new Error('Clipboard denied'))
        : new Promise<void>((resolve) => { finishCopy = resolve; }));
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: mode === 'missing' ? undefined : { writeText },
      });
      let fixture: ComponentFixture<ProviderAccountsTabComponent> | undefined;
      try {
        fixture = await render();
        const row = opencodeSection(fixture).querySelector<HTMLElement>('.machine-row')!;
        const command = row.querySelector('code')!.textContent!.trim();
        expect(command).toMatch(/^node -e /);
        row.querySelector<HTMLButtonElement>('button')!.click();
        await settle(fixture);
        if (mode === 'success') {
          expect(fixture.nativeElement.querySelector('[role="status"]')).toBeNull();
          expect(writeText).toHaveBeenCalledExactlyOnceWith(command);
          finishCopy();
          await settle(fixture);
          expect(fixture.nativeElement.querySelector('[role="status"]')?.textContent)
            .toContain('Copied the sign-in command. Run it in a terminal on that machine.');
        } else {
          expect(writeText).toHaveBeenCalledTimes(mode === 'missing' ? 0 : 1);
          if (mode === 'denied') expect(writeText).toHaveBeenCalledWith(command);
          expect(fixture.nativeElement.querySelector('[role="status"]')?.textContent)
            .toContain('Could not copy. Select the command shown beside this button and copy it yourself.');
          expect(fixture.nativeElement.querySelector('[role="status"]')?.textContent).not.toMatch(/^Copied /);
        }
        expect(row.querySelector('code')?.textContent?.trim()).toBe(command);
      } finally {
        fixture?.destroy();
        if (original) ipc.list.mockImplementation(original);
        if (priorClipboard) Object.defineProperty(navigator, 'clipboard', priorClipboard);
        else Reflect.deleteProperty(navigator, 'clipboard');
        connectedNodesValue = [];
      }
    },
  );

  it('derives the per-machine sign-in command from the derived provider name', async () => {
    const fixture = await render();
    const command = fixture.componentInstance.nodeLoginCommand(mimoAccount());
    expect(command).toMatch(/^node -e /);
    const script = atob(command.match(/Buffer.from\('([^']+)'/)![1]);
    expect(script).toContain('aio-mimo-max-b-1a2b');
    expect(script).toContain('OPENCODE_MODELS_PATH:file');
    // The legacy account pins its region provider; no region falls back to the picker.
    const legacy = fixture.componentInstance.nodeLoginCommand(mimoAccount({ id: 'legacy', isLegacy: true }));
    const legacyScript = atob(legacy.match(/Buffer.from\('([^']+)'/)![1]);
    expect(legacyScript).toContain('xiaomi-token-plan-ams');
    expect(legacyScript).toContain("['--version']");
    expect(legacyScript).toContain("['auth','import','--standalone']");
    const picker = fixture.componentInstance.nodeLoginCommand(mimoAccount({ id: 'legacy', isLegacy: true, region: undefined }));
    const pickerScript = atob(picker.match(/Buffer.from\('([^']+)'/)![1]);
    expect(pickerScript).toContain("['--version']");
    expect(pickerScript).toContain("chosen.major===2?['auth','login','--standalone']:['auth','login']");
    fixture.destroy();
  });

  describe('providers with no account list', () => {
    it('offers a Sign in button for each of them so a reauth banner always lands somewhere useful', async () => {
      const fixture = await render();
      const root = fixture.nativeElement as HTMLElement;
      const rows = Array.from(root.querySelectorAll<HTMLElement>('.sign-in-row'));
      expect(rows.map((row) => row.getAttribute('data-provider'))).toEqual(['gemini', 'antigravity', 'cursor', 'grok']);
      expect(rows.map((row) => row.querySelector('strong')?.textContent?.trim())).toEqual([
        'Gemini', 'Antigravity', 'Cursor', 'Grok',
      ]);
      expect(rows.every((row) => row.querySelector('button')?.textContent?.trim() === 'Sign in')).toBe(true);
      fixture.destroy();
    });

    it('opens a terminal running that provider’s sign-in command and reports where it landed', async () => {
      const fixture = await render();
      const root = fixture.nativeElement as HTMLElement;
      try {
        root.querySelector<HTMLButtonElement>('[data-testid="sign-in-grok"]')!.click();
        await settle(fixture);
        expect(providerIpc.runProviderLogin).toHaveBeenCalledExactlyOnceWith('grok');
        expect(fixture.componentInstance.notice()).toContain('Terminal');
        expect(fixture.componentInstance.notice()).toContain('grok login');
        // No account card owns this, so the feedback shows at the top of the page.
        expect(root.querySelector('.provider-accounts-tab > [role="status"]')?.textContent)
          .toContain('grok login');
      } finally {
        fixture.destroy();
      }
    });

    it('shows the launcher failure when no terminal could be opened', async () => {
      providerIpc.runProviderLogin.mockResolvedValueOnce({
        success: false,
        error: { message: 'No known sign-in command for provider "grok".' },
      });
      const fixture = await render();
      const root = fixture.nativeElement as HTMLElement;
      try {
        root.querySelector<HTMLButtonElement>('[data-testid="sign-in-grok"]')!.click();
        await settle(fixture);
        expect(root.querySelector('.provider-accounts-tab > [role="alert"]')?.textContent)
          .toContain('No known sign-in command');
      } finally {
        fixture.destroy();
      }
    });
  });
});
