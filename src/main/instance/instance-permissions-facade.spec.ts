import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  inheritSubagentPermissions,
  loadOptionalProjectRules,
  mapCliPermissionActionToScope,
  normalizeRequestedPath,
} from './instance-permissions-facade';

const { loadProjectRules, applySubagentPermissionsMock } = vi.hoisted(() => ({
  loadProjectRules: vi.fn(),
  applySubagentPermissionsMock: vi.fn(),
}));

vi.mock('../security/permission-manager', () => ({
  getPermissionManager: () => ({ loadProjectRules }),
}));

vi.mock('../orchestration/derive-subagent-permission', () => ({
  applySubagentPermissions: (...args: unknown[]) => applySubagentPermissionsMock(...args),
}));

describe('instance-permissions-facade', () => {
  it('maps CLI permission verbs onto permission scopes', () => {
    expect(mapCliPermissionActionToScope('Read')).toBe('file_read');
    expect(mapCliPermissionActionToScope('edit_file')).toBe('file_write');
    expect(mapCliPermissionActionToScope('remove')).toBe('file_delete');
    expect(mapCliPermissionActionToScope('ls')).toBe('directory_read');
    expect(mapCliPermissionActionToScope('Bash')).toBe('tool_use');
  });

  it('resolves relative requested paths against the working directory', () => {
    expect(normalizeRequestedPath('/tmp/proj', './src/a.ts')).toBe(path.join('/tmp/proj', './src/a.ts'));
    expect(normalizeRequestedPath('/tmp/proj', '/abs/file.ts')).toBe('/abs/file.ts');
    expect(normalizeRequestedPath('/tmp/proj', 'plain')).toBe('plain');
  });

  it('loads project rules and inherits child permissions through the facade', () => {
    loadOptionalProjectRules('/tmp/proj');
    inheritSubagentPermissions({
      childId: 'child-1',
      parentId: 'parent-1',
      parentPlanModeActive: true,
    });

    expect(loadProjectRules).toHaveBeenCalledWith('/tmp/proj');
    expect(applySubagentPermissionsMock).toHaveBeenCalledWith('child-1', {
      parentInstanceId: 'parent-1',
      permissionManager: { loadProjectRules },
      parentPlanModeActive: true,
    });
  });
});
