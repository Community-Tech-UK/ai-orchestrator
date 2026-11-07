import { describe, expect, it } from 'vitest';

import { PERMISSION_SCOPE_WORDS } from '../../../../shared/permissions/permission-scope-presentation';
import {
  approveLabelFor,
  canTellWhatToDoInstead,
  permissionHintFor,
  canAddClaudeAllowRule,
  decisionFor,
  permissionAskKind,
  permissionScopesFor,
  rejectLabelFor,
  scopeOptionLabel,
  canResolveInputRequiredWithYolo,
  defaultInputRequiredScope,
  isPermissionDenialRequest,
  shouldClearInputRequiredForYolo,
  shouldClearRequestAfterYoloEnabled
} from './user-action-request.rules';

describe('user action request rules', () => {
  it('keeps questions and forms visible when tool permissions are automatic', () => {
    for (const type of ['ask_user_question', 'acp_elicitation']) {
      const request = { instanceId: 'inst-1', requestType: 'input_required', permissionMetadata: { type } };
      expect(shouldClearInputRequiredForYolo(request)).toBe(false);
      expect(canResolveInputRequiredWithYolo(request)).toBe(false);
    }
  });
  it('keeps Claude permission-denial prompts visible while YOLO is enabled', () => {
    const request = {
      instanceId: 'inst-1',
      requestType: 'input_required',
      permissionMetadata: { type: 'permission_denial' },
    };

    expect(isPermissionDenialRequest(request)).toBe(true);
    expect(shouldClearInputRequiredForYolo(request)).toBe(false);
    expect(shouldClearRequestAfterYoloEnabled(request, 'inst-1')).toBe(false);
    expect(canResolveInputRequiredWithYolo(request)).toBe(false);
  });

  it('clears normal input_required prompts after YOLO is enabled for the same instance', () => {
    const request = {
      instanceId: 'inst-1',
      requestType: 'input_required',
      permissionMetadata: { type: 'deferred_permission' },
    };

    expect(shouldClearInputRequiredForYolo(request)).toBe(true);
    expect(shouldClearRequestAfterYoloEnabled(request, 'inst-1')).toBe(true);
    expect(shouldClearRequestAfterYoloEnabled(request, 'inst-2')).toBe(false);
    expect(canResolveInputRequiredWithYolo(request)).toBe(true);
  });

  it('defaults permission-denial prompts to Always so the allow rule is written', () => {
    expect(defaultInputRequiredScope({ type: 'permission_denial' })).toBe('always');
    expect(defaultInputRequiredScope({ type: 'deferred_permission' })).toBe('once');
    expect(defaultInputRequiredScope(undefined)).toBe('once');
  });
});

describe('permission card decisions', () => {
  const denial = { type: 'permission_denial', tool_name: 'Edit' };
  const held = { type: 'deferred_permission', tool_name: 'Bash' };
  const single = { type: 'codex_mcp_approval' };

  it('restricts Claude denials to supported persistent rules', () => {
    expect(permissionAskKind(denial)).toBe('claude-denial');
    for (const tool_name of ['Write', 'Edit', 'Read', 'Bash']) {
      expect(canAddClaudeAllowRule({ ...denial, tool_name })).toBe(true);
      expect(permissionScopesFor({ ...denial, tool_name })).toEqual(['always']);
    }
    expect(canAddClaudeAllowRule({ ...denial, tool_name: 'WebFetch' })).toBe(false);
    expect(permissionScopesFor({ ...denial, tool_name: 'WebFetch' })).toEqual([]);
    expect(permissionScopesFor({ type: 'permission_denial' })).toEqual([]);
  });

  it('points an unsupported-tool denial at the Auto-approve control at the top of the session, without the old YOLO name', () => {
    const hint = permissionHintFor({ type: 'permission_denial', tool_name: 'WebFetch' }, 'always');
    expect(hint).toContain('switch on Auto-approve at the top of this session');
    expect(hint).not.toContain('YOLO');
    expect(hint).toContain('~/.claude/settings.json');
  });

  it('offers three scopes for held commands and only Once for single approvals', () => {
    expect(permissionAskKind(held)).toBe('claude-held');
    expect(permissionScopesFor(held)).toEqual(['once', 'session', 'always']);
    expect(defaultInputRequiredScope(held)).toBe('once');
    expect(permissionAskKind(single)).toBe('single');
    expect(permissionScopesFor(single)).toEqual(['once']);
  });

  it('names each permission scope in the approve and reject labels', () => {
    expect(approveLabelFor(denial, 'always')).toBe('Always allow (adds a rule to ~/.claude/settings.json and restarts)');
    expect(rejectLabelFor(denial, 'always')).toBe("Don't allow");
    expect(approveLabelFor({ ...denial, tool_name: 'WebFetch' }, 'always')).toBeUndefined();
    expect(rejectLabelFor({ ...denial, tool_name: 'WebFetch' }, 'always')).toBe('OK');
    expect(approveLabelFor(single, 'once')).toBe('Allow this once');
    expect(rejectLabelFor(single, 'once')).toBe("Don't allow");
    const expected = [
      ['once', 'Once', 'Allow this once', "Don't allow"],
      ['session', 'This session', 'Allow for this session', 'Block for this session'],
      ['always', 'Always', 'Always allow this command', 'Always block this command'],
    ] as const;
    for (const [scope, option, approve, reject] of expected) {
      expect(scopeOptionLabel(scope)).toBe(option);
      expect(approveLabelFor(held, scope)).toBe(approve);
      expect(rejectLabelFor(held, scope)).toBe(reject);
    }
  });

  it('takes every scope word from the list the browser and registry cards share', () => {
    for (const scope of ['once', 'session', 'always'] as const) {
      const words = PERMISSION_SCOPE_WORDS[scope];
      expect(scopeOptionLabel(scope)).toBe(words.choice);
      expect(approveLabelFor(held, scope)).toContain(words.allow);
      expect(rejectLabelFor(held, scope)).toContain(words.refuse);
    }
  });

  it('dismisses denial refusals without a decision and forces supported grants to Always', () => {
    expect(decisionFor(denial, false, 'always')).toBeUndefined();
    expect(decisionFor(denial, true, 'once')).toEqual({ action: 'allow', scope: 'always' });
    expect(decisionFor({ ...denial, tool_name: 'WebFetch' }, true, 'always')).toBeUndefined();
  });

  it('refuses held commands without caching Once but records explicitly selected blocking scopes', () => {
    expect(decisionFor(held, false, 'once')).toEqual({ action: 'deny' });
    expect(decisionFor(held, false, 'session')).toEqual({ action: 'deny', scope: 'session' });
    expect(decisionFor(held, false, 'always')).toEqual({ action: 'deny', scope: 'always' });
    expect(decisionFor(held, true, 'once')).toEqual({ action: 'allow', scope: 'once' });
    expect(decisionFor(single, true, 'always')).toEqual({ action: 'allow', scope: 'once' });
  });
});

describe('live card tools and refusal notes', () => {
  it('offers refusal notes only on Claude held or denial cards', () => {
    for (const type of ['deferred_permission', 'permission_denial']) expect(canTellWhatToDoInstead({ type })).toBe(true);
    for (const type of ['codex_mcp_approval', 'acp_permission_request', 'ask_user_question']) expect(canTellWhatToDoInstead({ type })).toBe(false);
  });
  it('names non-shell tools and tells the truth about strict once', () => {
    for (const tool_name of ['Write', 'WebFetch', 'mcp__browser-gateway__browser_health']) {
      const meta = { type: 'deferred_permission', live: true, tool_name };
      expect(defaultInputRequiredScope(meta)).toBe('once');
      expect(approveLabelFor(meta, 'once')).toBe(PERMISSION_SCOPE_WORDS.once.allow);
      expect(approveLabelFor(meta, 'session')).toContain(tool_name === 'Write' ? 'Write' : tool_name === 'WebFetch' ? 'WebFetch' : 'browser_health (browser-gateway)');
      expect(permissionHintFor(meta, 'once')).toBe('Allows only this call.');
      expect(permissionHintFor(meta, 'always')).toContain('Settings > Permissions > Rules');
    }
  });
});
