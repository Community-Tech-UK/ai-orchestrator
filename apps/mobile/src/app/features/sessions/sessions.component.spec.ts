import '@angular/compiler';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { MobileHistorySessionDto, MobileInstanceDto } from '../../core/models';
import {
  SessionsComponent,
  SESSION_PAGE_SIZE,
  nextSessionsPageSize,
  sessionChipForRow,
  sessionsShowMoreLabel,
} from './sessions.component';

describe('sessions pagination controls', () => {
  it('advertises the next page size instead of implying every hidden session will load', () => {
    expect(nextSessionsPageSize(124)).toBe(SESSION_PAGE_SIZE);
    expect(sessionsShowMoreLabel(124)).toBe('Show 10 more (124 remaining)');
  });

  it('uses the remaining count when fewer than a full page is hidden', () => {
    expect(nextSessionsPageSize(4)).toBe(4);
    expect(sessionsShowMoreLabel(4)).toBe('Show 4 more');
  });
});

describe('session row status chip', () => {
  it('shows loop state for live looping sessions before the generic status label', () => {
    expect(sessionChipForRow({
      live: true,
      isLooping: true,
      status: 'idle',
      pendingApprovalCount: 0,
    })).toEqual({ kind: 'loop', label: 'Loop' });
  });

  it('keeps approval and past-session chips ahead of loop state', () => {
    expect(sessionChipForRow({
      live: true,
      isLooping: true,
      status: 'waiting_for_permission',
      pendingApprovalCount: 1,
    })).toEqual({ kind: 'attention', label: 'Needs your OK' });

    expect(sessionChipForRow({
      live: false,
      isLooping: true,
      status: 'idle',
      pendingApprovalCount: 0,
    })).toEqual({ kind: 'past', label: 'past' });
  });
});


describe('SessionsComponent connection header', () => {
  const source = readFileSync(resolve('src/app/features/sessions/sessions.component.ts'), 'utf8');

  /**
   * This screen used to hard-code 'Connected'/'Offline', so an expired pairing
   * read as an ordinary network drop one level below the Projects screen.
   */
  it('reports the connection state rather than a hard-coded Offline', () => {
    expect(source).toContain('[subtitle]="connectionHeadline()"');
    expect(source).toContain('connectionHeadline(this.gateway.state())');
    expect(source).not.toContain("online() ? 'Connected' : 'Offline'");
  });
});


describe('canonical live question on session rows', () => {
  it('keeps a question ahead of loop state even when no permission counter is present', () => {
    expect(sessionChipForRow({ live: true, isLooping: true, status: 'waiting_for_input', pendingApprovalCount: 0 }))
      .toEqual({ kind: 'attention', label: 'Needs your answer' });
  });

  it('does not relabel a question as permission when the generic pending count is positive', () => {
    expect(sessionChipForRow({ live: true, isLooping: true, status: 'waiting_for_input', pendingApprovalCount: 1 }))
      .toEqual({ kind: 'attention', label: 'Needs your answer' });
  });
});


describe('one project\'s sessions, worktrees included', () => {
  const instance = (id: string, workingDirectory: string): MobileInstanceDto => ({
    id, displayName: id, status: 'idle', provider: 'codex', workingDirectory, projectName: workingDirectory.split('/').at(-1)!,
    createdAt: 1, lastActivity: 1, pendingApprovalCount: 0, hasUnreadCompletion: false,
  });
  const past = (id: string, workingDirectory: string, hiddenFromProjects?: boolean): MobileHistorySessionDto => ({
    id, name: id, provider: 'codex', model: null, workingDirectory, projectName: 'x', createdAt: 1, lastActiveAt: 1,
    archived: true, live: false, ...(hiddenFromProjects ? { hiddenFromProjects } : {}),
  });

  function render(projectKey: string) {
    const navigate = vi.fn();
    TestBed.configureTestingModule({ imports: [SessionsComponent], providers: [
      { provide: GatewayClient, useValue: {
        snapshot: signal({ instances: [instance('queue-worker', '/work/aio/.worktrees/queue/item-1'), instance('other', '/work/other')], projects: [] }),
        historySessions: signal([past('repo-past', '/work/aio'), past('finished-queue-run', '/work/aio/.worktrees/queue/item-0', true)]),
        dataHostId: () => 'host-a', online: signal(true), state: signal('connected'), refreshSnapshot: vi.fn(),
      } },
      { provide: HostStore, useValue: { activeHost: signal({ id: 'host-a', name: 'Host' }) } },
      { provide: Router, useValue: { navigate } },
    ] });
    TestBed.overrideComponent(SessionsComponent, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA] } });
    const fixture = TestBed.createComponent(SessionsComponent);
    fixture.componentRef.setInput('projectKey', projectKey);
    fixture.detectChanges();
    const component = fixture.componentInstance as unknown as {
      sessions(): { id: string }[]; projectName(): string; newSession(): void;
    };
    return { component, navigate };
  }

  it.each(['/work/aio', '/work/aio/.worktrees/queue/item-1'])('lists the repository and its worktree sessions for route %s', (key) => {
    const { component, navigate } = render(key);
    expect(component.sessions().map((row) => row.id)).toEqual(['queue-worker', 'repo-past']);
    expect(component.projectName()).toBe('aio');
    component.newSession();
    expect(navigate).toHaveBeenCalledWith(['/new-session'], expect.objectContaining({ queryParams: { dir: '/work/aio' } }));
  });
});
