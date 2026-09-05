import { describe, expect, it } from 'vitest';
import { inferLoopPhase, loopPhaseLabel } from './loop-phase-inference';

function toolUse(message: string, detail?: Record<string, unknown>) {
  return { kind: 'tool_use', message, ...(detail ? { detail } : {}) };
}

describe('inferLoopPhase (L4)', () => {
  it('ignores anything that is not a tool call', () => {
    expect(inferLoopPhase({ kind: 'assistant', message: 'npm run verify' })).toBeNull();
    expect(inferLoopPhase({ kind: 'heartbeat', message: 'Edit' })).toBeNull();
    expect(inferLoopPhase({ kind: 'status', message: 'Read' })).toBeNull();
  });

  it('classifies read-only tools as investigating', () => {
    expect(inferLoopPhase(toolUse('Read', { toolName: 'Read' }))).toBe('investigating');
    expect(inferLoopPhase(toolUse('Grep', { toolName: 'Grep' }))).toBe('investigating');
    expect(inferLoopPhase(toolUse('Glob'))).toBe('investigating');
  });

  it('classifies mutating tools as editing', () => {
    expect(inferLoopPhase(toolUse('Edit', { toolName: 'Edit' }))).toBe('editing');
    expect(inferLoopPhase(toolUse('Write'))).toBe('editing');
    expect(inferLoopPhase(toolUse('MultiEdit'))).toBe('editing');
  });

  it('classifies sub-agent dispatch as reviewing', () => {
    expect(inferLoopPhase(toolUse('Task', { toolName: 'Task' }))).toBe('reviewing');
  });

  it('reads the command text for shell tools', () => {
    expect(inferLoopPhase(toolUse('Bash', { toolName: 'Bash', command: 'npm run verify' }))).toBe('verifying');
    expect(inferLoopPhase(toolUse('Bash', { toolName: 'Bash', command: 'npx vitest run src' }))).toBe('verifying');
    expect(inferLoopPhase(toolUse('Bash', { toolName: 'Bash', command: 'cargo test' }))).toBe('verifying');
    expect(inferLoopPhase(toolUse('Bash', { toolName: 'Bash', command: 'tsc --noEmit' }))).toBe('verifying');
  });

  // A `git status` inside Bash is inspection. Calling it verification would let
  // L3 hold a stall counter open while nothing is actually building.
  it('does not treat read-only shell commands as verification', () => {
    expect(inferLoopPhase(toolUse('Bash', { toolName: 'Bash', command: 'git status --short' }))).toBe('investigating');
    expect(inferLoopPhase(toolUse('Bash', { toolName: 'Bash', command: 'rg TODO src' }))).toBe('investigating');
  });

  it('returns null for an unrecognised tool rather than guessing', () => {
    expect(inferLoopPhase(toolUse('Frobnicate', { toolName: 'Frobnicate' }))).toBeNull();
    expect(inferLoopPhase(toolUse('Bash', { toolName: 'Bash', command: 'echo hello' }))).toBeNull();
  });

  it('falls back to the rendered message when no detail is supplied', () => {
    expect(inferLoopPhase({ kind: 'tool_use', message: 'Edit(src/app.ts)' })).toBe('editing');
  });

  it('labels every phase for the HUD', () => {
    expect(loopPhaseLabel('verifying')).toBe('running checks');
    expect(loopPhaseLabel('editing')).toBe('editing');
    expect(loopPhaseLabel('investigating')).toBe('investigating');
    expect(loopPhaseLabel('reviewing')).toBe('reviewing');
  });
});
