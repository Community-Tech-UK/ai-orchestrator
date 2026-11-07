import { describe, expect, it } from 'vitest';
import { friendlyToolName } from './friendly-tool-name';

describe('friendlyToolName', () => {
  it('puts the tool before its connector for connector tools', () => {
    expect(friendlyToolName('mcp__browser-gateway__browser_health')).toBe('browser_health (browser-gateway)');
  });
  it('leaves built-in tool names alone', () => {
    expect(friendlyToolName('WebFetch')).toBe('WebFetch');
  });
});
