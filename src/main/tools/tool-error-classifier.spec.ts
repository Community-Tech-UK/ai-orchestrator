import { describe, it, expect } from 'vitest';
import {
  classifyToolError,
  ToolErrorCategory,
} from './tool-error-classifier';

describe('classifyToolError', () => {
  it('classifies ENOENT as filesystem error', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const result = classifyToolError(err);
    expect(result.category).toBe(ToolErrorCategory.FILESYSTEM);
    expect(result.code).toBe('ENOENT');
    expect(result.telemetrySafe).toBe(true);
    expect(result.telemetryMessage).toBe('ENOENT');
  });

  it('classifies EACCES as permission error', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const result = classifyToolError(err);
    expect(result.category).toBe(ToolErrorCategory.PERMISSION);
    expect(result.code).toBe('EACCES');
    expect(result.telemetrySafe).toBe(true);
  });

  it('classifies timeout errors', () => {
    const err = new Error('Tool execution timed out');
    const result = classifyToolError(err);
    expect(result.category).toBe(ToolErrorCategory.TIMEOUT);
    expect(result.telemetrySafe).toBe(true);
  });

  it('classifies Zod validation errors', () => {
    const err = new Error('Invalid tool arguments');
    (err as any).name = 'ZodError';
    const result = classifyToolError(err);
    expect(result.category).toBe(ToolErrorCategory.VALIDATION);
    expect(result.telemetrySafe).toBe(true);
  });

  it('classifies unknown errors without leaking user data', () => {
    const err = new Error('Something with /Users/secret/path broke');
    const result = classifyToolError(err);
    expect(result.category).toBe(ToolErrorCategory.UNKNOWN);
    expect(result.telemetrySafe).toBe(true);
    expect(result.telemetryMessage).toBe('Error');
    // Original message preserved in non-telemetry field
    expect(result.originalMessage).toContain('/Users/secret/path');
  });
});
