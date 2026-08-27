import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CopilotAccountIpcService,
  type CopilotAccountDiagnosticsView,
  type CopilotAccountRuleView,
  type CopilotAccountView,
} from '../../core/services/ipc/copilot-account-ipc.service';
import { RecentDirectoriesIpcService } from '../../core/services/ipc/recent-directories-ipc.service';
import { CopilotAccountsTabComponent } from './copilot-accounts-tab.component';

function account(overrides: Partial<CopilotAccountView> = {}): CopilotAccountView {
  return {
    id: 'personal',
    label: 'Personal',
    expectedLogin: 'octocat',
    host: 'github.com',
    accountKind: 'personal',
    scopePolicy: 'default-eligible',
    automationPolicy: 'allow-routed',
    isDefault: true,
    isLegacy: false,
    createdAt: 1,
    updatedAt: 1,
    binding: { nodeId: 'local', state: 'authenticated', checkedAt: 1 },
    ...overrides,
  };
}

const rule: CopilotAccountRuleView = {
  id: 'rule-1',
  profileId: 'personal',
  matcher: { type: 'owner', host: 'github.com', owner: 'octocat' },
  isProtected: false,
  createdAt: 1,
  updatedAt: 1,
};

/** The shape every mutating IPC call returns; typed so a failure case can be
 *  stubbed without fighting inference. */
interface MutationResult {
  success: boolean;
  error?: { message?: string };
}

const ipc = {
  list: vi.fn(async (): Promise<CopilotAccountView[]> => [account()]),
  listRules: vi.fn(async (): Promise<CopilotAccountRuleView[]> => [rule]),
  diagnostics: vi.fn(
    async (): Promise<CopilotAccountDiagnosticsView> => ({
      aggregate: 'available',
      nodeId: 'local',
      unreachableRuleIds: [],
      conflictingRuleIds: [],
      ambientTokenVariablesPresent: [],
      legacyMigrationInUse: false,
      warnings: [],
    }),
  ),
  create: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  rename: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  updatePolicy: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  setDefault: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  remove: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  verifyBinding: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  adoptIdentity: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  createRule: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  removeRule: vi.fn(async (): Promise<MutationResult> => ({ success: true })),
  previewRoute: vi.fn(async () => null),
  suggestRules: vi.fn(async () => []),
  signIn: vi.fn(async () => ({ success: true })),
  discover: vi.fn(async () => []),
};

const recentDirectories = {
  getDirectories: vi.fn(async () => [
    {
      path: '/Users/me/work/widgets',
      displayName: 'widgets',
      lastAccessed: 2,
      accessCount: 3,
      isPinned: false,
    },
    // A remote-node folder is deliberately excluded from the picker: its path
    // cannot be inspected from here, so offering it would only ever produce a
    // confusing "no remotes found".
    {
      path: 'C:\\work\\remote',
      displayName: 'remote',
      lastAccessed: 1,
      accessCount: 1,
      isPinned: false,
      nodeId: 'worker-1',
    },
  ]),
};

async function settle(fixture: ComponentFixture<CopilotAccountsTabComponent>): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
}

async function render(): Promise<ComponentFixture<CopilotAccountsTabComponent>> {
  const fixture = TestBed.createComponent(CopilotAccountsTabComponent);
  fixture.detectChanges();
  await settle(fixture);
  return fixture;
}

beforeEach(async () => {
  for (const spy of Object.values(ipc)) spy.mockClear();
  ipc.list.mockResolvedValue([account()]);
  ipc.listRules.mockResolvedValue([rule]);
  recentDirectories.getDirectories.mockClear();
  await TestBed.configureTestingModule({
    imports: [CopilotAccountsTabComponent],
    providers: [
      { provide: CopilotAccountIpcService, useValue: ipc },
      { provide: RecentDirectoriesIpcService, useValue: recentDirectories },
    ],
  }).compileComponents();
});

describe('CopilotAccountsTabComponent', () => {
  it('shows each account with its identity, host, and sign-in state', async () => {
    const fixture = await render();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Personal');
    expect(text).toContain('octocat');
    expect(text).toContain('github.com');
    expect(text).toContain('Signed in');
  });

  it('never renders a Copilot home path', async () => {
    const fixture = await render();
    expect(fixture.nativeElement.textContent).not.toMatch(/copilot-cli-(home|profiles)/);
  });

  it('explains an identity mismatch and offers to adopt the observed account', async () => {
    ipc.list.mockResolvedValue([
      account({
        binding: {
          nodeId: 'local',
          state: 'identity-mismatch',
          observedLogin: 'someone-else',
          checkedAt: 1,
        },
      }),
    ]);
    const fixture = await render();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('signed in as');
    expect(text).toContain('someone-else');

    await fixture.componentInstance.adoptObserved(fixture.componentInstance.accounts()[0]);
    expect(ipc.adoptIdentity).toHaveBeenCalledWith('personal', 'someone-else', undefined);
  });

  it('warns when a profile stores its token in plaintext', async () => {
    ipc.list.mockResolvedValue([
      account({
        binding: {
          nodeId: 'local',
          state: 'authenticated',
          checkedAt: 1,
          storesTokenPlaintext: true,
        },
      }),
    ]);
    const fixture = await render();
    expect(fixture.nativeElement.textContent).toContain('plain file');
  });

  it('surfaces routing conflict warnings from diagnostics', async () => {
    ipc.diagnostics.mockResolvedValue({
      aggregate: 'available',
      nodeId: 'local',
      unreachableRuleIds: [],
      conflictingRuleIds: ['r1', 'r2'],
      ambientTokenVariablesPresent: [],
      legacyMigrationInUse: false,
      warnings: ['2 Copilot routing rule(s) map the same target to different accounts'],
    });
    const fixture = await render();
    expect(fixture.nativeElement.textContent).toContain('map the same target to different accounts');
  });

  it('groups rules under their own account', async () => {
    const fixture = await render();
    expect(fixture.componentInstance.rulesFor('personal')).toHaveLength(1);
    expect(fixture.componentInstance.rulesFor('enterprise')).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('github.com/octocat/*');
  });

  it('surfaces a rejected mutation instead of failing silently', async () => {
    ipc.remove.mockResolvedValue({
      success: false,
      error: { message: 'That Copilot account is in use by a running session.' },
    });
    const fixture = await render();
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    await fixture.componentInstance.remove(fixture.componentInstance.accounts()[0]);
    await settle(fixture);
    expect(fixture.componentInstance.error()).toContain('in use by a running session');
  });

  it('creates a folder rule as protected by default', async () => {
    const fixture = await render();
    fixture.componentInstance.workspacePath = '/Users/me/work';
    fixture.componentInstance.pathRuleProfileId = 'personal';
    await fixture.componentInstance.addPathRule();
    expect(ipc.createRule).toHaveBeenCalledWith({
      profileId: 'personal',
      matcher: { type: 'path-prefix', canonicalPath: '/Users/me/work' },
      isProtected: true,
    });
  });

  it('signs in through the profile-scoped launcher, not a bare provider login', async () => {
    const fixture = await render();
    await fixture.componentInstance.signIn(fixture.componentInstance.accounts()[0]);
    expect(ipc.signIn).toHaveBeenCalledWith('personal', 'github.com');
  });

  it('offers recent local folders so a path never has to be typed', async () => {
    const fixture = await render();
    // Typing a path was the actual barrier to mapping a workspace: the folder
    // is known to the app, and the owner/repo are derived from its remotes.
    expect(fixture.componentInstance.recentWorkspaces().map((e) => e.path)).toEqual([
      '/Users/me/work/widgets',
    ]);
    expect(fixture.nativeElement.textContent).toContain('widgets');
  });

  it('checks the workspace immediately when one is picked', async () => {
    const fixture = await render();
    fixture.componentInstance.onWorkspacePicked('/Users/me/work/widgets');
    await settle(fixture);
    expect(ipc.suggestRules).toHaveBeenCalledWith('/Users/me/work/widgets');
    expect(fixture.componentInstance.workspacePath).toBe('/Users/me/work/widgets');
  });

  it('does not check when the picker is cleared', async () => {
    const fixture = await render();
    fixture.componentInstance.onWorkspacePicked('');
    await settle(fixture);
    expect(ipc.suggestRules).not.toHaveBeenCalled();
  });

  it('points at the folder rule when a checkout has no GitHub remote', async () => {
    ipc.suggestRules.mockResolvedValue([]);
    const fixture = await render();
    // Before Check runs, the "no remote" guidance must NOT be shown — absence
    // of results is not the same as a result of none.
    expect(fixture.nativeElement.textContent).not.toContain('No GitHub remote was found');

    fixture.componentInstance.onWorkspacePicked('/Users/me/work/widgets');
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('No GitHub remote was found');
  });
});
