import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_CONSISTENCY_CHECKS } from '../src/main/orchestration/review-ui-consistency';

const guidePath = 'docs/screen-and-wording-guide.md';
const guide = readFileSync(resolve(guidePath), 'utf8');

describe('screen and wording guide', () => {
  it('is discoverable from the agent instructions and stays one page', () => {
    expect(readFileSync(resolve('AGENTS.md'), 'utf8')).toContain(guidePath);
    expect(guide.split('\n').length).toBeLessThanOrEqual(140);
    expect(guide).toContain('Harness');
    expect([...guide.matchAll(/^## (\d)\./gm)].map(match => match[1])).toEqual(['1', '2', '3', '4', '5', '6']);
  });
  it('points only at real repository paths', () => {
    const paths = [...guide.matchAll(/`((?:src|docs|scripts|packages)\/[^`]+)`/g)].map(match => match[1]);
    for (const path of paths) expect(existsSync(resolve(path)), path).toBe(true);
  });
  it('keeps the shell standards consistent with the guide', () => {
    const shell = readFileSync(resolve('docs/shell-component-standards.md'), 'utf8');
    expect(shell).not.toContain('AI Orchestrator');
    expect(shell).not.toContain('`title` on every button');
    expect(shell.slice(shell.indexOf('## 8.'))).toContain('tooltip');
  });
  it('keeps the advisory reviewer checks aligned with section 6', () => {
    const reviewSection = guide.slice(guide.indexOf('## 6.'));
    for (const check of UI_CONSISTENCY_CHECKS) expect(reviewSection).toContain(check.guideKeyword);
  });
});
