import { describe, expect, it } from 'vitest';
import { normalizeAndHash } from '../ast-normalize';

describe('normalizeAndHash', () => {
  it('returns SHA-256 hex strings for both content and AST-normalized hashes', () => {
    const result = normalizeAndHash('export function foo() { return 1; }', 'typescript');
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.astNormalizedHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('content hash differs for two semantically-identical strings with different whitespace', () => {
    const a = normalizeAndHash('export function foo(){return 1;}', 'typescript');
    const b = normalizeAndHash('export function foo() {\n  return 1;\n}', 'typescript');
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('AST-normalized hash is identical for whitespace-only-different code', () => {
    const a = normalizeAndHash('export function foo(){return 1;}', 'typescript');
    const b = normalizeAndHash('export function foo() {\n  return 1;\n}', 'typescript');
    expect(a.astNormalizedHash).toBe(b.astNormalizedHash);
  });

  it('AST-normalized hash differs when logic changes', () => {
    const a = normalizeAndHash('export function foo() { return 1; }', 'typescript');
    const b = normalizeAndHash('export function foo() { return 2; }', 'typescript');
    expect(a.astNormalizedHash).not.toBe(b.astNormalizedHash);
  });

  it('strips non-doc comments from AST-normalized hash but keeps logic-bearing tokens', () => {
    const a = normalizeAndHash('export function foo() { /* comment */ return 1; }', 'typescript');
    const b = normalizeAndHash('export function foo() { return 1; }', 'typescript');
    expect(a.astNormalizedHash).toBe(b.astNormalizedHash);
  });

  it('returns content-hash-only fallback when language is unsupported', () => {
    const result = normalizeAndHash('foo bar baz', 'cobol');
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.astNormalizedHash).toBe(result.contentHash);
  });
});
