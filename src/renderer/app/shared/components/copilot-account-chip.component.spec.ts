import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopilotRouteOutcome } from '../../../../shared/types/copilot-account.types';
import {
  CopilotAccountIpcService,
  type CopilotAccountView,
} from '../../core/services/ipc/copilot-account-ipc.service';
import { CopilotAccountChipComponent } from './copilot-account-chip.component';

const account = (id: string, label: string): CopilotAccountView => ({
  id,
  label,
  expectedLogin: id,
  host: 'github.com',
  accountKind: 'personal',
  scopePolicy: 'default-eligible',
  automationPolicy: 'allow-routed',
  isDefault: id === 'personal',
  isLegacy: false,
  createdAt: 1,
  updatedAt: 1,
});

const ipc = {
  previewRoute: vi.fn<() => Promise<CopilotRouteOutcome | null>>(),
  list: vi.fn(async () => [account('personal', 'Personal'), account('enterprise', 'Enterprise')]),
};

async function render(inputs: {
  provider: string | null;
  workingDirectory?: string | null;
}): Promise<ComponentFixture<CopilotAccountChipComponent>> {
  const fixture = TestBed.createComponent(CopilotAccountChipComponent);
  fixture.componentRef.setInput('provider', inputs.provider);
  fixture.componentRef.setInput('workingDirectory', inputs.workingDirectory ?? null);
  fixture.detectChanges();
  await settle(fixture);
  return fixture;
}

/**
 * The component resolves its route through a plain promise. This app is
 * zoneless, so `whenStable()` does not track that work — drain the microtask
 * queue explicitly before asserting on rendered output.
 */
async function settle(fixture: ComponentFixture<CopilotAccountChipComponent>): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
}

beforeEach(async () => {
  ipc.previewRoute.mockReset();
  ipc.list.mockClear();
  await TestBed.configureTestingModule({
    imports: [CopilotAccountChipComponent],
    providers: [{ provide: CopilotAccountIpcService, useValue: ipc }],
  }).compileComponents();
});

describe('CopilotAccountChipComponent', () => {
  it('renders nothing and never routes for a non-Copilot provider', async () => {
    const fixture = await render({ provider: 'claude', workingDirectory: '/w' });
    expect(fixture.nativeElement.textContent.trim()).toBe('');
    expect(ipc.previewRoute).not.toHaveBeenCalled();
  });

  it('shows the resolved account and the repository it matched', async () => {
    ipc.previewRoute.mockResolvedValue({
      ok: true,
      route: {
        profileId: 'enterprise',
        source: 'repository',
        executionNodeId: 'local',
        profileLabel: 'Enterprise',
        repository: { host: 'github.com', owner: 'acme', repo: 'widgets' },
      },
    });
    const fixture = await render({ provider: 'copilot', workingDirectory: '/w' });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Enterprise');
    expect(text).toContain('github.com/acme/widgets');
  });

  it('shows the specific remedy — not a generic unavailable — when routing is blocked', async () => {
    ipc.previewRoute.mockResolvedValue({
      ok: false,
      code: 'profile-unauthenticated',
      detail: 'Copilot account "Enterprise" is not signed in on this device.',
      profileId: 'enterprise',
    });
    const fixture = await render({ provider: 'copilot', workingDirectory: '/w' });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('not signed in on this device');
    expect(text).not.toContain('Copilot unavailable');
  });

  it('emits blocked so the host can disable Start', async () => {
    ipc.previewRoute.mockResolvedValue({
      ok: false,
      code: 'ambiguous-remotes',
      detail: 'This workspace resolves to more than one Copilot account.',
    });
    const fixture = await render({ provider: 'copilot', workingDirectory: '/w' });
    const blocked: boolean[] = [];
    fixture.componentInstance.blocked.subscribe((value) => blocked.push(value));
    // Re-resolve by changing the workspace, so a fresh emission is observed.
    fixture.componentRef.setInput('workingDirectory', '/other');
    await settle(fixture);
    expect(blocked).toContain(true);
  });

  it('emits the resolved account ID for the create payload', async () => {
    ipc.previewRoute.mockResolvedValue({
      ok: true,
      route: {
        profileId: 'personal',
        source: 'default',
        executionNodeId: 'local',
        profileLabel: 'Personal',
      },
    });
    const fixture = await render({ provider: 'copilot', workingDirectory: '/w' });
    const resolved: (string | null)[] = [];
    fixture.componentInstance.accountResolved.subscribe((value) => resolved.push(value));
    fixture.componentRef.setInput('workingDirectory', '/other');
    await settle(fixture);
    expect(resolved).toContain('personal');
  });

  it('offers an override only when more than one account exists', async () => {
    ipc.previewRoute.mockResolvedValue({
      ok: true,
      route: {
        profileId: 'personal',
        source: 'default',
        executionNodeId: 'local',
        profileLabel: 'Personal',
      },
    });
    const many = await render({ provider: 'copilot', workingDirectory: '/w' });
    expect(many.nativeElement.querySelector('select.override')).not.toBeNull();

    ipc.list.mockResolvedValueOnce([account('personal', 'Personal')]);
    const one = await render({ provider: 'copilot', workingDirectory: '/w2' });
    expect(one.nativeElement.querySelector('select.override')).toBeNull();
  });
});
