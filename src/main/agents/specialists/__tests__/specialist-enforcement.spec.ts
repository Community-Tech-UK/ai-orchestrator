import { describe, it, expect } from 'vitest';
import { applySpecialistConstraints } from '../../../../shared/utils/permission-mapper.js';
import type { AgentToolPermissions } from '../../../../shared/types/agent.types.js';
import type { SpecialistConstraints } from '../../../../shared/types/specialist.types.js';

describe('applySpecialistConstraints', () => {
  const fullPermissions: AgentToolPermissions = {
    read: 'allow',
    write: 'allow',
    bash: 'allow',
    web: 'allow',
    task: 'allow',
  };

  it('should deny write when readOnlyMode is true', () => {
    const constraints: SpecialistConstraints = { readOnlyMode: true };
    const result = applySpecialistConstraints(fullPermissions, constraints);
    expect(result.write).toBe('deny');
    expect(result.read).toBe('allow');
  });

  it('should set bash to ask when sandboxedExecution is true', () => {
    const constraints: SpecialistConstraints = { sandboxedExecution: true };
    const result = applySpecialistConstraints(fullPermissions, constraints);
    expect(result.bash).toBe('ask');
  });

  it('should apply both readOnly and sandboxed together', () => {
    const constraints: SpecialistConstraints = { readOnlyMode: true, sandboxedExecution: true };
    const result = applySpecialistConstraints(fullPermissions, constraints);
    expect(result.write).toBe('deny');
    expect(result.bash).toBe('ask');
  });

  it('should return permissions unchanged when no constraints', () => {
    const result = applySpecialistConstraints(fullPermissions, {});
    expect(result).toEqual(fullPermissions);
  });

  it('should not weaken existing deny permissions', () => {
    const restricted: AgentToolPermissions = {
      read: 'allow',
      write: 'deny',
      bash: 'deny',
      web: 'allow',
      task: 'allow',
    };
    const constraints: SpecialistConstraints = { sandboxedExecution: true };
    const result = applySpecialistConstraints(restricted, constraints);
    expect(result.bash).toBe('deny'); // deny is stricter than ask, keep deny
  });
});
