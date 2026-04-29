import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, Input, signal } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChildInstancesPanelComponent } from './child-instances-panel.component';
import { InstanceStore, type Instance } from '../../core/state/instance.store';
import type { HudQuickAction } from '../../../../shared/types/orchestration-hud.types';
import { StatusIndicatorComponent } from '../instance-list/status-indicator.component';

@Component({
  selector: 'app-status-indicator',
  standalone: true,
  template: '',
})
class StatusIndicatorStubComponent {
  @Input() status: unknown;
}

describe('ChildInstancesPanelComponent', () => {
  let fixture: ComponentFixture<ChildInstancesPanelComponent>;
  const activities = signal(new Map<string, string>());
  const instances = new Map<string, Instance>();
  const fakeStore = {
    getInstance: (id: string) => instances.get(id),
    instanceActivities: activities.asReadonly(),
  };

  beforeEach(async () => {
    instances.clear();
    instances.set('active-1', makeInstance('active-1', 'busy', {
      spawnPromptHash: 'active-hash',
      statusTimeline: [
        { status: 'initializing', timestamp: 1_900_000_000_000 },
        { status: 'busy', timestamp: 1_900_000_001_000 },
      ],
    }));
    instances.set('waiting-1', makeInstance('waiting-1', 'waiting_for_permission', {
      spawnPromptHash: 'waiting-hash',
    }));
    activities.set(new Map([['active-1', 'Running checks']]));

    TestBed.overrideComponent(ChildInstancesPanelComponent, {
      remove: { imports: [StatusIndicatorComponent] },
      add: { imports: [StatusIndicatorStubComponent] },
    });
    await TestBed.configureTestingModule({
      imports: [ChildInstancesPanelComponent],
      providers: [{ provide: InstanceStore, useValue: fakeStore }],
    }).compileComponents();

    fixture = TestBed.createComponent(ChildInstancesPanelComponent);
    (fixture.componentInstance as unknown as { childrenIds: () => string[] }).childrenIds =
      () => ['active-1', 'waiting-1'];
    fixture.detectChanges();
  });

  it('renders child state counts and activity context', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Agents (2)');
    expect(text).toContain('1 active');
    expect(text).toContain('1 waiting');
    expect(text).toContain('Running checks');
    expect(text).toContain('worker');
  });

  it('emits a focus selection when the Focus action is clicked', () => {
    const selected: string[] = [];
    fixture.componentInstance.selectChild.subscribe((id) => selected.push(id));

    const activeRow = findRow('active-1', fixture.nativeElement);
    const focusButton = Array.from(activeRow.querySelectorAll('.text-action'))
      .find((button) => (button as HTMLElement).textContent?.includes('Focus')) as HTMLButtonElement;
    focusButton.click();

    expect(selected).toEqual(['active-1']);
  });

  it('emits prompt hash and diagnostics quick actions', () => {
    const actions: HudQuickAction[] = [];
    fixture.componentInstance.quickAction.subscribe((action) => actions.push(action));

    const activeRow = findRow('active-1', fixture.nativeElement);
    const buttons = Array.from(activeRow.querySelectorAll('.text-action')) as HTMLButtonElement[];
    const copyButton = buttons.find((button) => button.textContent?.includes('Copy hash'));
    const diagnosticsButton = buttons.find((button) => button.textContent?.includes('Diagnostics'));

    copyButton?.click();
    diagnosticsButton?.click();

    expect(actions).toEqual([
      {
        kind: 'copy-prompt-hash',
        childInstanceId: 'active-1',
        spawnPromptHash: 'active-hash',
      },
      { kind: 'open-diagnostic-bundle', childInstanceId: 'active-1' },
    ]);
  });
});

function makeInstance(
  id: string,
  status: Instance['status'],
  orchestration: Record<string, unknown> = {},
): Instance {
  return {
    id,
    displayName: id,
    createdAt: 1_900_000_000_000,
    historyThreadId: `history-${id}`,
    parentId: 'parent-1',
    childrenIds: [],
    agentId: 'worker',
    agentMode: 'build',
    provider: 'codex',
    status,
    contextUsage: { used: 0, total: 200_000, percentage: 0 },
    lastActivity: 1_900_000_002_000,
    providerSessionId: `provider-${id}`,
    sessionId: `session-${id}`,
    restartEpoch: 0,
    workingDirectory: '/repo',
    yoloMode: false,
    outputBuffer: [],
    pendingApprovalCount: 0,
    metadata: {
      orchestration: {
        role: 'worker',
        heartbeatAt: 1_900_000_002_000,
        ...orchestration,
      },
    },
  };
}

function findRow(displayName: string, root: HTMLElement): HTMLElement {
  const row = Array.from(root.querySelectorAll('.child-item'))
    .find((item) => item.textContent?.includes(displayName));
  if (!row) {
    throw new Error(`Missing child row for ${displayName}`);
  }
  return row as HTMLElement;
}
