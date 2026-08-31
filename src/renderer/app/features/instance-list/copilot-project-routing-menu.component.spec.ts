import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CopilotAccountIpcService,
  type CopilotAccountRuleView,
  type CopilotAccountView,
} from '../../core/services/ipc/copilot-account-ipc.service';
import type { CopilotRouteOutcome } from '../../../../shared/types/copilot-account.types';
import { CopilotProjectRoutingMenuComponent } from './copilot-project-routing-menu.component';

function account(
  id: string,
  label: string,
  isDefault = false,
  bindingState: 'authenticated' | 'unauthenticated' = 'authenticated',
): CopilotAccountView {
  return {
    id,
    label,
    // Signed in by default: an account that cannot run is the exception, and
    // making it the fixture default hid which tests were exercising which path.
    binding: { nodeId: 'local', state: bindingState, checkedAt: 1 },
    expectedLogin: id,
    host: 'github.com',
    accountKind: id === 'personal' ? 'personal' : 'enterprise',
    scopePolicy: isDefault ? 'default-eligible' : 'matched-only',
    automationPolicy: 'allow-routed',
    isDefault,
    isLegacy: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

interface MutationResult {
  success: boolean;
  error?: { message?: string };
}

const ownerRule: CopilotAccountRuleView = {
  id: 'rule-1',
  profileId: 'enterprise',
  matcher: { type: 'owner', host: 'github.com', owner: 'acme' },
  isProtected: true,
  createdAt: 1,
  updatedAt: 1,
};

const ipc = {
  list: vi.fn(async () => [account('personal', 'Personal', true), account('enterprise', 'Work')]),
  listRules: vi.fn(async () => [ownerRule]),
  // Typed against the union, not inferred from the first literal — otherwise
  // `mockResolvedValueOnce` cannot express a different source or a failure.
  previewRoute: vi.fn<() => Promise<CopilotRouteOutcome | null>>(async () => ({
    ok: true,
    route: {
      profileId: 'personal',
      source: 'default',
      executionNodeId: 'local',
      profileLabel: 'Personal',
    },
  })),
  suggestRules: vi.fn(async () => [
    {
      remoteName: 'origin',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
      displayPath: 'acme/widgets',
    },
  ]),
  discover: vi.fn(async (): Promise<
    { login: string; host: string; alreadyAdded: boolean }[]
  > => []),
  create: vi.fn<() => Promise<MutationResult & { data?: { id?: string } }>>(async () => ({
    success: true,
    data: { id: 'work' },
  })),
  createRule: vi.fn<() => Promise<MutationResult>>(async () => ({ success: true })),
  signIn: vi.fn<() => Promise<MutationResult>>(async () => ({ success: true })),
  removeRule: vi.fn<() => Promise<MutationResult>>(async () => ({ success: true })),
};

async function settle(fixture: ComponentFixture<CopilotProjectRoutingMenuComponent>) {
  for (let tick = 0; tick < 5; tick += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
}

async function render(path: string | null) {
  const fixture = TestBed.createComponent(CopilotProjectRoutingMenuComponent);
  fixture.componentRef.setInput('projectPath', path);
  fixture.detectChanges();
  await settle(fixture);
  return fixture;
}

beforeEach(async () => {
  for (const spy of Object.values(ipc)) spy.mockClear();
  await TestBed.configureTestingModule({
    imports: [CopilotProjectRoutingMenuComponent],
    providers: [{ provide: CopilotAccountIpcService, useValue: ipc }],
  }).compileComponents();
});

describe('CopilotProjectRoutingMenuComponent', () => {
  it('is visible with only one account, and says why nothing can be routed', async () => {
    // Regression: an earlier version required TWO accounts, which hid this in
    // exactly the state where it is most needed — you cannot map, and a silent
    // menu gives you no way to find out why.
    ipc.list.mockResolvedValueOnce([account('personal', 'Personal', true)]);
    const fixture = await render('/work/widgets');
    expect(fixture.componentInstance.visible()).toBe(true);
    expect(fixture.componentInstance.onlyOneAccount()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Add a second account in Settings');
  });

  it('offers an account Copilot already holds but Harness has not added', async () => {
    ipc.list.mockResolvedValueOnce([account('personal', 'Personal', true)]);
    ipc.discover.mockResolvedValueOnce([
      { login: 'LAWRENCJ_PE1', host: 'github.com', alreadyAdded: false },
    ]);
    const fixture = await render('/work/widgets');
    expect(fixture.componentInstance.addable().map((c) => c.login)).toEqual(['LAWRENCJ_PE1']);
    expect(fixture.nativeElement.textContent).toContain('LAWRENCJ_PE1');
    // Marked with an "Add" badge rather than a sentence, so the row reads as a
    // menu item and not wrapping prose.
    expect(fixture.nativeElement.querySelector('.cpr-badge')?.textContent?.trim()).toBe('Add');
    // Something IS actionable, so the dead-end hint must not show.
    expect(fixture.componentInstance.onlyOneAccount()).toBe(false);
  });

  it('adds the account and maps the project in one action', async () => {
    ipc.list.mockResolvedValueOnce([account('personal', 'Personal', true)]);
    ipc.discover.mockResolvedValueOnce([
      { login: 'LAWRENCJ_PE1', host: 'github.com', alreadyAdded: false },
    ]);
    const fixture = await render('/work/widgets');
    await fixture.componentInstance.addAndMapTo(
      { login: 'LAWRENCJ_PE1', host: 'github.com', alreadyAdded: false },
      new Event('click'),
    );
    expect(ipc.create).toHaveBeenCalledWith({
      label: 'LAWRENCJ_PE1',
      accountKind: 'enterprise',
      host: 'github.com',
      // Recorded, or discovery offers this same account again forever.
      expectedLogin: 'LAWRENCJ_PE1',
    });
    expect(ipc.createRule).toHaveBeenCalledWith({
      profileId: 'work',
      matcher: { type: 'owner', host: 'github.com', owner: 'acme' },
      replaceExisting: true,
    });
  });

  it('does not map when adding the account fails', async () => {
    ipc.list.mockResolvedValueOnce([account('personal', 'Personal', true)]);
    ipc.create.mockResolvedValueOnce({
      success: false,
      error: { message: 'At most one Copilot account profile may be the default' },
    });
    const fixture = await render('/work/widgets');
    await fixture.componentInstance.addAndMapTo(
      { login: 'LAWRENCJ_PE1', host: 'github.com', alreadyAdded: false },
      new Event('click'),
    );
    expect(ipc.createRule).not.toHaveBeenCalled();
    expect(fixture.componentInstance.error()).toContain('At most one');
  });

  it('hides an account that is already added', async () => {
    ipc.discover.mockResolvedValueOnce([
      { login: 'shutupandshave', host: 'github.com', alreadyAdded: true },
    ]);
    const fixture = await render('/work/widgets');
    expect(fixture.componentInstance.addable()).toHaveLength(0);
  });

  it('lists accounts and marks the one this project currently resolves to', async () => {
    const fixture = await render('/work/widgets');
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Personal');
    expect(text).toContain('Work');
    expect(fixture.componentInstance.activeProfileId()).toBe('personal');
    // The tick lives in its own fixed-width span, so assert against the DOM
    // rather than a concatenated text blob.
    const ticked = [...fixture.nativeElement.querySelectorAll('.cpr-item')].find(
      (item) => (item as HTMLElement).querySelector('.cpr-tick')?.textContent?.trim() === '✓',
    ) as HTMLElement | undefined;
    expect(ticked?.textContent).toContain('Personal');
    // The healthy case is conveyed by the tick alone — a header line repeating
    // it was duplication, and the main source of clutter.
    expect(fixture.componentInstance.blockedReason()).toBeNull();
  });

  it('maps a repository with a remote using an OWNER rule', async () => {
    const fixture = await render('/work/widgets');
    await fixture.componentInstance.mapTo(account('enterprise', 'Work'), new Event('click'));
    // Owner, not repository: mapping one repo of an employer's org almost
    // always means the siblings too, and a per-repo rule would silently leave
    // them on the personal account.
    expect(ipc.createRule).toHaveBeenCalledWith({
      profileId: 'enterprise',
      matcher: { type: 'owner', host: 'github.com', owner: 'acme' },
      // A swap, not an add: picking an account for a project that already has
      // one must MOVE the rule rather than collide with it.
      replaceExisting: true,
    });
  });

  it('maps a remote-less checkout as a protected folder rule', async () => {
    ipc.suggestRules.mockResolvedValueOnce([]);
    const fixture = await render('/work/no-remote');
    await fixture.componentInstance.mapTo(account('enterprise', 'Work'), new Event('click'));
    expect(ipc.createRule).toHaveBeenCalledWith({
      profileId: 'enterprise',
      matcher: { type: 'path-prefix', canonicalPath: '/work/no-remote' },
      isProtected: true,
      replaceExisting: true,
    });
  });

  it('surfaces a rejected mapping instead of closing silently', async () => {
    ipc.createRule.mockResolvedValueOnce({
      success: false,
      error: { message: 'That target is already routed to a different Copilot account.' },
    });
    const fixture = await render('/work/widgets');
    const emitted: void[] = [];
    fixture.componentInstance.mapped.subscribe(() => emitted.push(undefined));
    await fixture.componentInstance.mapTo(account('enterprise', 'Work'), new Event('click'));
    await settle(fixture);
    expect(fixture.componentInstance.error()).toContain('already routed');
    expect(emitted).toHaveLength(0);
  });

  it('only offers to clear a mapping that a rule actually made', async () => {
    // Resolved by `default` — no rule decided it, so there is nothing to clear.
    const byDefault = await render('/work/widgets');
    expect(byDefault.componentInstance.mappedRules()).toHaveLength(0);

    ipc.previewRoute.mockResolvedValueOnce({
      ok: true,
      route: {
        profileId: 'enterprise',
        source: 'owner',
        ruleId: 'rule-1',
        executionNodeId: 'local',
        profileLabel: 'Work',
      },
    });
    const byRule = await render('/work/other');
    expect(byRule.componentInstance.mappedRules().map((r) => r.id)).toEqual(['rule-1']);
  });

  it('reports a blocked route rather than implying a working account', async () => {
    ipc.previewRoute.mockResolvedValueOnce({
      ok: false,
      code: 'profile-unauthenticated',
      detail: 'Not signed in on this device.',
    });
    const fixture = await render('/work/widgets');
    expect(fixture.componentInstance.blockedReason()).toContain('Not signed in');
    expect(fixture.nativeElement.textContent).toContain('Not signed in');
    expect(fixture.componentInstance.activeProfileId()).toBeNull();
  });

  it('does nothing without a project path', async () => {
    await render(null);
    expect(ipc.previewRoute).not.toHaveBeenCalled();
  });

  it('carries its own menu styling rather than relying on the host component', async () => {
    // Regression: these items originally reused `.project-menu-item`, whose
    // rules are view-encapsulated to instance-list.component — so they never
    // applied here and the menu rendered as unstyled, centred, wrapping text.
    const fixture = await render('/work/widgets');
    const item = fixture.nativeElement.querySelector('.cpr-item') as HTMLElement | null;
    expect(item).not.toBeNull();
    expect(item?.classList.contains('project-menu-item')).toBe(false);
    // Left-aligned, full-width rows with a fixed tick gutter and an elided label.
    expect(fixture.nativeElement.querySelector('.cpr-tick')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.cpr-text')).not.toBeNull();
  });

  it('enables its items once loading settles', async () => {
    // "Cannot select either" would also be the symptom of a stuck busy flag.
    const fixture = await render('/work/widgets');
    expect(fixture.componentInstance.busy()).toBe(false);
    const items = [...fixture.nativeElement.querySelectorAll('.cpr-item')] as HTMLButtonElement[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => !item.disabled)).toBe(true);
  });
});

describe('swapping a project between accounts', () => {
  // Reported 2026-08-30: the menu could only ever ADD a rule, so switching a
  // project from one account to another came back "That target is already
  // routed to a different Copilot account. Remove the existing rule first."
  // — and clicking the account it was already on said "That routing rule
  // already exists for this account." Neither is a thing a user can act on
  // from this menu, which is the one place the swap is meant to happen.
  it('does nothing when the project is already on that account', async () => {
    // The default harness preview resolves to `personal`, so clicking
    // `personal` is the already-there case.
    const fixture = await render('/work/widgets');
    ipc.createRule.mockClear();

    await fixture.componentInstance.mapTo(account('personal', 'Personal', true), new Event('click'));

    expect(ipc.createRule, 'a second click on the active account must not re-issue the rule')
      .not.toHaveBeenCalled();
    expect(fixture.componentInstance.error()).toBeNull();
  });
});

describe('an account that is not signed in on this device', () => {
  // Reported 2026-08-30: picking the newly added LAWRENCJ_PE1 gave
  // "not signed in on this device. Sign in for this profile from Settings ›
  // GitHub Copilot Accounts." — a dead end in the one menu where the choice is
  // made. Each profile has its own isolated COPILOT_HOME, so a fresh profile
  // genuinely has no credentials; the fix is to offer the login here.
  it('starts sign-in instead of mapping a project to an account that cannot run', async () => {
    const signedOut = account('enterprise', 'Work', false, 'unauthenticated');
    ipc.list.mockResolvedValueOnce([account('personal', 'Personal', true), signedOut]);
    const fixture = await render('/work/widgets');
    ipc.createRule.mockClear();

    await fixture.componentInstance.mapTo(signedOut, new Event('click'));

    expect(ipc.signIn).toHaveBeenCalledWith('enterprise', 'github.com');
    expect(ipc.createRule, 'do not park a project on an account that cannot run')
      .not.toHaveBeenCalled();
    expect(fixture.componentInstance.error()).toContain('Finish signing in');
  });

  it('maps normally once the account IS signed in', async () => {
    const fixture = await render('/work/widgets');
    await fixture.componentInstance.mapTo(account('enterprise', 'Work'), new Event('click'));
    expect(ipc.signIn).not.toHaveBeenCalled();
    expect(ipc.createRule).toHaveBeenCalled();
  });
});

describe('swapping away from a PROTECTED rule', () => {
  // James's real state: ~/work/ebrd is pinned to `lawrencj-pe1` by a PROTECTED
  // path rule. Swapping it back to the personal account must be possible — but
  // not silently, because a protected scope is what stops work in an
  // employer's org sliding onto a personal seat.
  it('asks once, then completes the move', async () => {
    ipc.createRule
      .mockResolvedValueOnce({
        success: false,
        error: { message: 'That target is protected for Copilot account "enterprise".' },
      })
      .mockResolvedValueOnce({ success: true });
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);

    const fixture = await render('/work/ebrd');
    await fixture.componentInstance.mapTo(account('enterprise', 'Work'), new Event('click'));

    expect(confirmSpy).toHaveBeenCalled();
    expect(ipc.createRule).toHaveBeenCalledTimes(2);
    const secondCall = ipc.createRule.mock.calls[1] as unknown as [{ confirmProtectedOverride?: boolean }];
    expect(secondCall[0]).toMatchObject({ confirmProtectedOverride: true });
    expect(fixture.componentInstance.error()).toBeNull();
    confirmSpy.mockRestore();
  });

  it('leaves the protected rule alone when the answer is no', async () => {
    ipc.createRule.mockResolvedValueOnce({
      success: false,
      error: { message: 'That target is protected for Copilot account "enterprise".' },
    });
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);

    const fixture = await render('/work/ebrd');
    await fixture.componentInstance.mapTo(account('enterprise', 'Work'), new Event('click'));

    expect(ipc.createRule, 'declining must not retry the move').toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });
});
