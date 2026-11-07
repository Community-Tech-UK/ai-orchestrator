import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { InstanceRowComponent } from './instance-row.component';
import { InstanceStore, type Instance } from '../../core/state/instance.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { ToolLoopAlertStore } from '../../core/state/tool-loop-alert.store';
import { SideChatStore } from '../../core/state/side-chat.store';
await resolveComponentResources(async url => url.endsWith('.html') ? readFileSync(join(__dirname, basename(url)), 'utf8') : '');
describe('session row live activity', () => {
  const liveActivities = signal(new Map<string, string>());
  beforeEach(async () => {
    TestBed.resetTestingModule(); liveActivities.set(new Map());
    await TestBed.configureTestingModule({ imports: [InstanceRowComponent], providers: [
      { provide: InstanceStore, useValue: { liveActivities, instanceActivities: () => new Map([['session', 'Agent active']]) } },
      { provide: RemoteNodeStore, useValue: { nodeById: () => undefined } },
      { provide: ToolLoopAlertStore, useValue: { hasCriticalAlert: () => false } },
      { provide: SideChatStore, useValue: { attentionFor: () => null } },
    ] }).compileComponents();
  });
  function render(status: Instance['status']) {
    const f = TestBed.createComponent(InstanceRowComponent);
    f.componentRef.setInput('instance', { id: 'session', displayName: 'Example', childrenIds: [], status, provider: 'codex', activityState: 'active' } as unknown as Instance); f.detectChanges(); return f;
  }
  it('shows the same live thought only while busy, with no live region', () => {
    liveActivities.set(new Map([['session', 'Thinking · Checking migrations']]));
    const f = render('busy'); const line = f.nativeElement.querySelector('.activity-line');
    expect(line.textContent).toContain('Thinking · Checking migrations'); expect(line.getAttribute('aria-live')).toBeNull();
    f.componentRef.setInput('instance', { id: 'session', displayName: 'Example', childrenIds: [], status: 'idle', provider: 'codex' }); f.detectChanges();
    expect(f.nativeElement.querySelector('.activity-line')).toBeNull();
  });
  it('does not show a second line for the Agent active fallback', () => {
    const f = render('busy'); expect(f.nativeElement.querySelector('.activity-line')).toBeNull();
  });
});
