import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractPlan, extractPlanHeader, PLAN_BRIEF_BYTES, readPlanBrief, readPlanHeader } from './plan-queue-plan-extract';

// Trimmed structure from 2026-10-20-oct2-phaseB-land-built-work_plan.md.
const fixture = `# Oct-2 Phase B

## Status
On main: no. Next: Step 2.

## Step 2. One replaceable status block
- [x] Read first.
- [ ] Keep one Status block.
Done when:
- The prompt names the root history path.

## Step 3. One-off diet
- [ ] Move dated evidence verbatim.
**Acceptance:**
- Keep the step bodies.

## Final verification
Run all gates.
`;

describe('plan extraction', () => {
  it('extracts the status and bounded open work, without completed items', () => {
    const result = extractPlan(fixture);
    expect(result.status).toBe('On main: no. Next: Step 2.');
    expect(result.acceptance).toContain('Keep one Status block');
    expect(result.acceptance).toContain('The prompt names the root history path');
    expect(result.acceptance).toContain('Keep the step bodies');
    expect(result.acceptance).not.toContain('[x]');
  });

  it('ignores fenced examples', () => {
    const result = extractPlan('## Status\nReal.\n\n```md\n## Status\nExample\n- [ ] example\n```\n- [ ] Real item\n');
    expect(result.status).toBe('Real.\n\n```md\n## Status\nExample\n- [ ] example\n```\n- [ ] Real item');
    expect(result.acceptance).toBe('- [ ] Real item');
  });

  it('bounds UTF-8 briefs and reports truncation with a source-reading instruction', () => {
    const result = extractPlan('- [ ] ' + '界'.repeat(5000));
    expect(Buffer.byteLength(result.acceptance)).toBeLessThanOrEqual(PLAN_BRIEF_BYTES);
    expect(result.acceptance).toContain('Read the source');
    expect(result.acceptance).not.toContain('�');
  });

  it('treats a closing marker with an info string as fence content', () => {
    const doc = '~~~\n- [ ] Example\n~~~js\n- [ ] Example too\n~~~\n- [ ] Real\n';
    expect(extractPlan(doc).acceptance).toBe('- [ ] Real');
  });

  it('closes a fence on a bare marker at least as long as the opener', () => {
    expect(extractPlan('~~~\n- [ ] Example\n~~~~\n- [ ] Real\n').acceptance).toBe('- [ ] Real');
  });

  it('omits completed checklist entries and keeps plain acceptance bullets', () => {
    const result = extractPlan('## Step 1. Work\nDone when:\n- [x] Finished\n- [ ] Still open\n- A plain acceptance bullet\n');
    expect(result.acceptance).not.toContain('Finished');
    expect(result.acceptance).toContain('Still open');
    expect(result.acceptance).toContain('A plain acceptance bullet');
  });

  it('keeps only the first 40 lines as the triage header', () => {
    const header = extractPlanHeader(Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n'));
    expect(header.split('\n')).toHaveLength(40);
    expect(header).toContain('line 40');
    expect(header).not.toContain('line 41');
  });
});

describe('plan files on disk', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a brief and a header from a plan file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'plan-extract-'));
    const file = join(dir, 'a_plan.md');
    writeFileSync(file, fixture);
    expect((await readPlanBrief(file)).status).toBe('On main: no. Next: Step 2.');
    expect(readPlanHeader(file)).toContain('# Oct-2 Phase B');
  });

  it.each(['## Status (7 Nov)', '## Status: nearly done', '## status'])('finds the Status block under the heading "%s"', heading => {
    expect(extractPlan(`# Plan\n\n${heading}\nNext: Step 4.\n\n## Step 4\n- [ ] Do it\n`).status).toBe('Next: Step 4.');
  });

  it('reads a CRLF plan: Status, open items and a dated heading', () => {
    const result = extractPlan('# Plan\r\n\r\n## Status (7 Nov)\r\nNext: Step 4.\r\n\r\n## Step 4\r\n- [ ] Do it\r\n');
    expect(result.status).toBe('Next: Step 4.');
    expect(result.acceptance).toBe('- [ ] Do it');
  });

  it('skips a fenced example heading before the real Status, and a fenced "## " inside it', () => {
    const result = extractPlan('# Plan\n\n```md\n## Status\nFake.\n```\n\n## Status\nReal.\n```\n## Inner\n```\nMore.\n\n## Step 1\n');
    expect(result.status).toContain('Real.');
    expect(result.status).toContain('More.');
    expect(result.status).not.toContain('Fake.');
  });

  it('finds a Status heading on the last line without a newline', () => {
    expect(extractPlan('# Plan\n\n## Status').status).toBe('');
  });

  it('finds the Status block under an em-dash heading', () => {
    expect(extractPlan('# Plan\n\n## Status \u2014 7 Nov\nNext: Step 4.\n\n## Step 4\n').status).toBe('Next: Step 4.');
  });

  it('does not take a different heading that merely starts with Status', () => {
    expect(extractPlan('# Plan\n\n## Statusboard\nNope.\n').status).toContain('opening section');
  });

  it('tells the worker to read the opening section when the plan has no Status heading', () => {
    const result = extractPlan('# Plan\n\nSome text.\n\n- [ ] Item\n');
    expect(result.status).toContain("read the plan's opening section");
    expect(result.acceptance).toBe('- [ ] Item');
  });

  it('tells the agent to read the source when the plan cannot be read, rather than failing the job', async () => {
    dir = mkdtempSync(join(tmpdir(), 'plan-extract-'));
    const missing = join(dir, 'gone_plan.md');
    expect((await readPlanBrief(missing)).status).toContain('Source brief unavailable');
    expect(readPlanHeader(missing)).toContain('could not be read');
  });
});
