import { describe, expect, it } from 'vitest';
import { isSessionNotFoundText } from '../resume-error-classifier';
import { classifyCodexDiagnostic } from './exec-diagnostics';
import { claimCodexDiagnosticSlot, codexDiagnosticOutput, presentCodexDiagnostic } from './exec-log-presentation';

describe('claimCodexDiagnosticSlot', () => {
  it('lets one line per category through for a turn, and a new turn start fresh', () => {
    const turn = {};
    expect(claimCodexDiagnosticSlot(turn, { category: 'process', fatal: false })).toBe(true);
    expect(claimCodexDiagnosticSlot(turn, { category: 'process', fatal: false })).toBe(false);
    expect(claimCodexDiagnosticSlot(turn, { category: 'unknown', fatal: false })).toBe(true);
    expect(claimCodexDiagnosticSlot({}, { category: 'process', fatal: false })).toBe(true);
  });

  it('does not let a harmless line hide a fatal one of the same category', () => {
    const turn = {};
    expect(claimCodexDiagnosticSlot(turn, { category: 'sandbox', fatal: false })).toBe(true);
    expect(claimCodexDiagnosticSlot(turn, { category: 'sandbox', fatal: true })).toBe(true);
    expect(claimCodexDiagnosticSlot(turn, { category: 'sandbox', fatal: true })).toBe(false);
  });
});

describe('presentCodexDiagnostic', () => {
  const present = (line: string) => presentCodexDiagnostic(classifyCodexDiagnostic(line));

  it.each([
    ['ERROR codex_core::tools::router: error=Exit code: 1 PRIVATE_TEXT', 'unknown'],
    ['ERROR codex_core::mcp: MCP client for `search` failed to start: PRIVATE_TEXT', 'tool-server'],
    ['ERROR unauthorized PRIVATE_TEXT', 'auth'],
    ['ERROR connection reset PRIVATE_TEXT', 'network'],
    ['ERROR unknown model PRIVATE_TEXT', 'unknown'],
  ])('keeps provider text out of the sentence for %s', (line, category) => {
    const presented = present(line);
    expect(presented.category).toBe(category);
    expect(`${presented.headline} ${presented.whatToDo}`).not.toContain('PRIVATE_TEXT');
    expect(presented.rawDetail).toContain('PRIVATE_TEXT');
    expect(presented.whatToDo).toMatch(/^(What to do:|No action needed:)/);
  });

  it('says plainly that a harmless warning needs nothing', () => {
    const quiet = present('WARN codex_core::config: something odd');
    expect(quiet.whatToDo).toMatch(/^No action needed:/);
    expect(quiet.headline).not.toMatch(/couldn't finish|failed/i);
    expect(quiet).not.toHaveProperty('action');
  });

  it('lets a fatal unclassified line say the request could not finish', () => {
    expect(present('ERROR unknown model gpt-x').headline).toContain("couldn't finish");
  });

  it('puts a lost session in words the session-not-found handling still recognises', () => {
    const presented = present('ERROR thread not found: abc');
    expect(isSessionNotFoundText(presented.headline)).toBe(true);
    expect(presented.headline).not.toContain('abc');
  });

  it('caps what is kept for Details', () => {
    expect(present(`ERROR ${'x'.repeat(10_000)}`).rawDetail.length).toBeLessThanOrEqual(4000);
  });
});

describe('codexDiagnosticOutput', () => {
  it('shows errors as errors and the rest as system notes, with the original line only in the metadata', () => {
    const fatal = codexDiagnosticOutput(classifyCodexDiagnostic('2026-10-18T00:51:05Z ERROR unauthorized: token expired'));
    expect(fatal.type).toBe('error');
    expect(fatal.content).not.toContain('token expired');
    expect(fatal.metadata).toMatchObject({ diagnostic: true, category: 'auth', fatal: true, level: 'error', loggedAt: '2026-10-18T00:51:05Z' });
    const note = codexDiagnosticOutput(classifyCodexDiagnostic('WARN odd'));
    expect(note.type).toBe('system');
    expect(note.metadata).not.toHaveProperty('loggedAt');
  });
});
