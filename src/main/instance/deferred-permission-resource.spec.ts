import { describe, expect, it } from 'vitest';
import { deferredPermissionResource } from './deferred-permission-resource';
import { getToolExecutionGate } from '../security/tool-execution-gate';
import type { PermissionRequest } from '../security/permission-manager';

describe('deferredPermissionResource', () => {
  it('preserves an entire Bash command and keeps every other tool scoped to the tool', () => {
    const command = 'echo ' + 'x'.repeat(500);
    expect(deferredPermissionResource('Bash', { command })).toEqual({ scope: 'bash_execute', resource: `bash:${command}` });
    expect(deferredPermissionResource('Bash', {})).toEqual({ scope: 'bash_execute', resource: 'tool:Bash' });
    expect(deferredPermissionResource('mcp__server__tool', {})).toEqual({ scope: 'tool_use', resource: 'tool:mcp__server__tool' });
    expect(deferredPermissionResource('Write', { file_path: './a.ts' })).toEqual({ scope: 'tool_use', resource: 'tool:Write' });
  });

  // A held Write or Edit asked for permission because nothing had allowed it. If it were scoped to its file,
  // the built-in "allow writes in the project folder" rule would answer it and the person would never see it.
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('a deferred %s inside the project folder still asks the person', tool => {
    const workingDirectory = process.cwd();
    const input = { file_path: `${workingDirectory}/a.ts`, notebook_path: `${workingDirectory}/a.ipynb`, content: 'x', old_string: 'a', new_string: 'b', edits: [] };
    const { scope, resource } = deferredPermissionResource(tool, input);
    const request: PermissionRequest = {
      id: 'perm-defer-test', instanceId: 'i', scope, resource, timestamp: Date.now(),
      context: { toolName: tool, workingDirectory, isChildInstance: false, depth: 0, yoloMode: false, agentId: undefined },
    };
    expect(getToolExecutionGate().evaluate({ request, toolName: tool, toolInput: input }).action).toBe('ask');
  });
});
