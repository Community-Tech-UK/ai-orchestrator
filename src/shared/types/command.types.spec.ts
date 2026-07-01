import { describe, expect, it } from 'vitest';
import { parseCommandString, resolveTemplate, BUILT_IN_COMMANDS } from './command.types';
import { parseArgsFromQuery } from '../utils/command-args';

describe('built-in /goal command', () => {
  it('is exposed as an orchestrator loop command instead of a provider-native slash command', () => {
    const command = BUILT_IN_COMMANDS.find((candidate) => candidate.name === 'goal');

    expect(command?.execution).toEqual({ type: 'goal' });
    expect(command?.applicability?.provider).toBeUndefined();
    expect(command?.applicability?.requiresWorkingDirectory).toBe(true);
    expect(command?.disabledReason).toMatch(/working directory/i);
  });
});

describe('resolveTemplate', () => {
  it('expands one-based argument slices with a bounded length', () => {
    expect(resolveTemplate('Review ${@:2:2}', ['alpha', 'beta', 'gamma', 'delta'])).toBe('Review beta gamma');
  });

  it('uses default values for missing positional arguments', () => {
    expect(resolveTemplate('Mode ${2:-fast} for $1', ['review'])).toBe('Mode fast for review');
  });

  it('uses provided positional arguments before default fallbacks', () => {
    expect(resolveTemplate('Mode ${2:-fast} for ${1:-review}', ['ship', 'carefully'])).toBe(
      'Mode carefully for ship'
    );
  });

  it('treats multi-digit positional placeholders as one argument index', () => {
    const args = Array.from({ length: 10 }, (_, index) => `arg${index + 1}`);

    expect(resolveTemplate('$10 $1', args)).toBe('arg10 arg1');
  });

  it('preserves spaces from quoted command arguments when slicing templates', () => {
    const args = parseArgsFromQuery('/ship "auth flow" src/main.ts "release notes.md"', 'ship');

    expect(args).toEqual(['auth flow', 'src/main.ts', 'release notes.md']);
    expect(resolveTemplate('Focus ${@:1:2}; fallback ${4:-none}', args)).toBe(
      'Focus auth flow src/main.ts; fallback none'
    );
  });

  it('removes unresolved slice and default placeholders with the existing placeholder cleanup', () => {
    expect(resolveTemplate('A ${@:x:y} B ${3:-} C ${7}', ['one'])).toBe('A  B  C');
  });

  it('keeps parseCommandString compatible with existing positional template args', () => {
    const parsed = parseCommandString('/review one two');

    expect(parsed?.args).toEqual(['one', 'two']);
    expect(resolveTemplate('$1 $2 $ARGUMENTS ${ARGUMENTS}', parsed?.args ?? [])).toBe(
      'one two one two one two'
    );
  });
});
