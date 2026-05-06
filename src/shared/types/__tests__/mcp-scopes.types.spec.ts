import { describe, expect, it } from 'vitest';
import {
  ALL_MCP_SCOPES,
  ORCHESTRATOR_INJECTION_PROVIDERS,
  PROVIDER_SCOPES,
  WRITABLE_SCOPES_BY_PROVIDER,
  isProviderScope,
  isSupportedProvider,
  isWritableScope,
} from '../mcp-scopes.types';

describe('mcp-scopes.types', () => {
  it('exposes all canonical scopes', () => {
    expect([...ALL_MCP_SCOPES].sort()).toEqual([
      'local',
      'managed',
      'orchestrator',
      'orchestrator-bootstrap',
      'orchestrator-codemem',
      'project',
      'shared',
      'system',
      'user',
      'workspace',
    ]);
  });

  it('classifies provider scopes', () => {
    expect(PROVIDER_SCOPES.claude).toEqual(['user', 'project', 'local']);
    expect(PROVIDER_SCOPES.codex).toEqual(['user']);
    expect(PROVIDER_SCOPES.gemini).toEqual(['user']);
    expect(PROVIDER_SCOPES.copilot).toEqual(['user', 'workspace', 'managed', 'system']);
  });

  it('restricts writes to user scope in v1', () => {
    expect(WRITABLE_SCOPES_BY_PROVIDER.claude).toEqual(['user']);
    expect(isWritableScope('claude', 'project')).toBe(false);
    expect(isWritableScope('claude', 'user')).toBe(true);
  });

  it('distinguishes provider-facing and virtual scopes', () => {
    expect(isProviderScope('user')).toBe(true);
    expect(isProviderScope('shared')).toBe(false);
    expect(isProviderScope('orchestrator')).toBe(false);
  });

  it('guards supported provider identifiers', () => {
    expect(isSupportedProvider('claude')).toBe(true);
    expect(isSupportedProvider('cursor')).toBe(false);
    expect(isSupportedProvider(undefined)).toBe(false);
  });

  it('keeps orchestrator inline injection scoped to providers that consume mcpConfig', () => {
    expect(ORCHESTRATOR_INJECTION_PROVIDERS).toEqual(['claude']);
  });
});
