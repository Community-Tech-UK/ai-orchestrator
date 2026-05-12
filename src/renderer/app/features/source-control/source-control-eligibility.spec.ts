import { describe, it, expect } from 'vitest';
import {
  isSourceControlEligible,
  type SourceControlEligibilityInput,
} from './source-control-eligibility';

function base(): SourceControlEligibilityInput {
  return {
    hasSelectedInstance: true,
    hasSelectedChat: false,
    isBenchmarkMode: false,
    isRemote: false,
    workingDirectory: '/work/project',
  };
}

describe('isSourceControlEligible', () => {
  it('returns true for a local instance with a working directory', () => {
    expect(isSourceControlEligible(base())).toBe(true);
  });

  it('returns false when no instance is selected', () => {
    expect(isSourceControlEligible({ ...base(), hasSelectedInstance: false })).toBe(false);
  });

  it('returns false when a chat is selected (workspace is in chat mode)', () => {
    expect(isSourceControlEligible({ ...base(), hasSelectedChat: true })).toBe(false);
  });

  it('returns false in benchmark mode', () => {
    expect(isSourceControlEligible({ ...base(), isBenchmarkMode: true })).toBe(false);
  });

  it('returns false for a remote instance (Tier D — not yet supported)', () => {
    expect(isSourceControlEligible({ ...base(), isRemote: true })).toBe(false);
  });

  it('returns false when working directory is null', () => {
    expect(isSourceControlEligible({ ...base(), workingDirectory: null })).toBe(false);
  });

  it('returns false when working directory is undefined', () => {
    expect(isSourceControlEligible({ ...base(), workingDirectory: undefined })).toBe(false);
  });

  it('returns false when working directory is empty or whitespace', () => {
    expect(isSourceControlEligible({ ...base(), workingDirectory: '' })).toBe(false);
    expect(isSourceControlEligible({ ...base(), workingDirectory: '   ' })).toBe(false);
  });
});
