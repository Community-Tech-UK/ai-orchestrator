import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CopilotAccountIpcService,
  type CopilotAccountRuleView,
  type CopilotAccountView,
} from '../../core/services/ipc/copilot-account-ipc.service';
import type { CopilotRouteOutcome } from '../../../../shared/types/copilot-account.types';
import { CopilotProjectRoutingMenuComponent } from './copilot-project-routing-menu.component';

function account(id: string, label: string, isDefault = false): CopilotAccountView {
  return {
    id,
    label,
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
  createRule: vi.fn<() => Promise<MutationResult>>(async () => ({ success: true })),
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
  it('stays hidden until a second account exists', async () => {
    ipc.list.mockResolvedValueOnce([account('personal', 'Personal', true)]);
    const fixture = await render('/work/widgets');
    // One account means nothing to choose between; an inert item is just noise.
    expect(fixture.componentInstance.visible()).toBe(false);
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });

  it('lists accounts and marks the one this project currently resolves to', async () => {
    const fixture = await render('/work/widgets');
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Personal');
    expect(text).toContain('Work');
    expect(fixture.componentInstance.activeProfileId()).toBe('personal');
    // The tick lives in its own fixed-width span, so assert against the DOM
    // rather than a concatenated text blob.
    const ticked = [...fixture.nativeElement.querySelectorAll('.project-menu-item')].find(
      (item) => (item as HTMLElement).querySelector('.copilot-tick')?.textContent?.trim() === '✓',
    ) as HTMLElement | undefined;
    expect(ticked?.textContent).toContain('Personal');
    expect(fixture.componentInstance.summary()).toBe('Personal (default)');
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
    expect(fixture.componentInstance.summary()).toContain('Blocked');
    expect(fixture.componentInstance.activeProfileId()).toBeNull();
  });

  it('does nothing without a project path', async () => {
    await render(null);
    expect(ipc.previewRoute).not.toHaveBeenCalled();
  });
});
