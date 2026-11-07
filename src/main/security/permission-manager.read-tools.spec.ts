import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ dir: '' }));

// Pin "home" so the manager's constructor-time disk load never reads the real ~/.orchestrator/permissions.json.
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mockHome.dir) },
}));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { deferredPermissionResource } from '../instance/deferred-permission-resource';
import { PermissionManager, type PermissionRequest } from './permission-manager';
import { getToolExecutionGate } from './tool-execution-gate';

/** What the real gate says to a held or live Claude ask for `tool`, exactly as the permission flow builds the request. */
function gateAction(tool: string, input: Record<string, unknown> = {}): 'allow' | 'deny' | 'ask' {
  const workingDirectory = mockHome.dir;
  const { scope, resource } = deferredPermissionResource(tool, input);
  const request: PermissionRequest = {
    id: 'perm-defer-test', instanceId: 'inst-1', scope, resource, timestamp: Date.now(),
    context: { toolName: tool, workingDirectory, isChildInstance: false, depth: 0, yoloMode: false, agentId: undefined },
  };
  return getToolExecutionGate().evaluate({ request, toolName: tool, toolInput: input }).action;
}

describe('the built-in "Allow Read Tools" rule, judged through the real permission gate', () => {
  let prevHome: string | undefined;

  beforeEach(() => {
    mockHome.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-read-tools-'));
    prevHome = process.env['HOME'];
    process.env['HOME'] = mockHome.dir;
    PermissionManager._resetForTesting();
  });

  afterEach(() => {
    PermissionManager._resetForTesting();
    if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome;
    fs.rmSync(mockHome.dir, { recursive: true, force: true });
  });

  // Reading stays automatic: these four are the read-only tools the rule was written for.
  it.each([
    ['Read', { file_path: 'a.ts' }],
    ['Glob', { pattern: '**/*.ts' }],
    ['Grep', { pattern: 'needle' }],
    ['LS', { path: '.' }],
  ])('lets the read-only %s tool through without asking', (tool, input) => {
    expect(gateAction(tool, input)).toBe('allow');
  });

  // The rule once matched any tool name that merely contained "read", "ls", "glob" or "grep".
  it.each([
    ['an MCP tool with "ls" in its name', 'mcp__files__tools_delete'],
    ['an MCP tool with "read" in its name', 'mcp__chat__create_thread'],
    ['Claude’s KillShell tool ("lS" inside "KillShell")', 'KillShell'],
    ['an MCP tool that only ends in a read-tool name', 'mcp__files__mass_Read'],
  ])('still asks about %s', (_label, tool) => {
    expect(gateAction(tool, {})).toBe('ask');
  });

  it('still asks for every held write tool', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(gateAction(tool, { file_path: 'a.ts' }), tool).toBe('ask');
  });
});
