import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  ɵresolveComponentResources as resolveComponentResources,
  signal,
} from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { InstanceStore, type Instance } from '../../../core/state/instance.store';
import type { HudQuickAction } from '../../../../../shared/types/orchestration-hud.types';
import { OrchestrationHudComponent } from '../orchestration-hud.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(
  resolve(specDirectory, '../orchestration-hud.component.html'),
  'utf8',
);
const styles = readFileSync(
  resolve(specDirectory, '../orchestration-hud.component.scss'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('orchestration-hud.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('orchestration-hud.component.scss')) {
    return Promise.resolve(styles);
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('OrchestrationHudComponent', () => {
  let fixture: ComponentFixture<OrchestrationHudComponent>;
  const instancesMap = signal(new Map<string, Instance>());
  const activities = signal(new Map<string, string>());
  const fakeStore = {
    instancesMap: instancesMap.asReadonly(),
    instanceActivities: activities.asReadonly(),
  };

  beforeEach(async () => {
    instancesMap.set(new Map([
      ['parent-1', makeInstance('parent-1', null, ['failed-1', 'waiting-1', 'active-1'])],
      ['failed-1', makeInstance('failed-1', 'parent-1', [], 'failed')],
      ['waiting-1', makeInstance('waiting-1', 'parent-1', [], 'waiting_for_input')],
      ['active-1', makeInstance('active-1', 'parent-1', [], 'busy')],
    ]));
    activities.set(new Map([['active-1', 'Running tests']]));

    await TestBed.configureTestingModule({
      imports: [OrchestrationHudComponent],
      providers: [{ provide: InstanceStore, useValue: fakeStore }],
    }).compileComponents();

    fixture = TestBed.createComponent(OrchestrationHudComponent);
    (fixture.componentInstance as unknown as { parentInstanceId: () => string }).parentInstanceId =
      () => 'parent-1';
    fixture.detectChanges();
  });

  it('renders child counts in the header', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('3 agents');
    expect(text).toContain('1 failed');
    expect(text).toContain('1 waiting');
    expect(text).toContain('1 active');
  });

  it('renders attention items', () => {
    const items = fixture.nativeElement.querySelectorAll('.attention-item');
    expect(items.length).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('failed-1');
    expect(fixture.nativeElement.textContent).toContain('waiting-1');
  });

  it('emits summarize quick action from the header action', () => {
    const actions: HudQuickAction[] = [];
    fixture.componentInstance.quickAction.subscribe((action) => actions.push(action));
    const button = fixture.nativeElement.querySelector('.hud-actions .text-action') as HTMLButtonElement;
    button.click();
    expect(actions).toEqual([{ kind: 'summarize-children', parentInstanceId: 'parent-1' }]);
  });

  it('collapses and expands the body', () => {
    fixture.componentInstance.toggleCollapsed();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.hud-body')).toBeNull();
    fixture.componentInstance.toggleCollapsed();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.hud-body')).toBeTruthy();
  });
});

function makeInstance(
  id: string,
  parentId: string | null,
  childrenIds: string[],
  status: Instance['status'] = 'idle',
): Instance {
  return {
    id,
    displayName: id,
    createdAt: 1_900_000_000_000,
    historyThreadId: `history-${id}`,
    parentId,
    childrenIds,
    agentId: parentId ? 'worker' : 'build',
    agentMode: 'build',
    provider: 'codex',
    status,
    contextUsage: { used: 0, total: 200_000, percentage: 0 },
    lastActivity: 1_900_000_000_000,
    providerSessionId: `provider-${id}`,
    sessionId: `session-${id}`,
    restartEpoch: 0,
    workingDirectory: '/repo',
    yoloMode: false,
    outputBuffer: [],
    pendingApprovalCount: 0,
    metadata: parentId ? {
      orchestration: {
        role: 'worker',
        spawnPromptHash: 'a'.repeat(64),
      },
    } : undefined,
  };
}
