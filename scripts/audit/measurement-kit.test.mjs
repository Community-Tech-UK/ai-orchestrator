import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('audit commands exclude research, deduplicate and retain source bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'audit-kit-'));
  try {
    const file = join(root, 'events.jsonl');
    const event = { messageId: 'one', sessionId: 'session', sessionKind: 'human', timestamp: 1000, contextTokens: 100, readTokens: 80, writeTokens: 20, outputTokens: 10, component: 'tools', toolName: 'read_node_output' };
    const source = [event, event, { ...event, messageId: 'research', sessionKind: 'research-sweep' }, { ...event, messageId: 'two', timestamp: 2000 }].map(row => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(file, source);
    for (const script of ['context-ceiling-replay', 'composition-scan', 'polling-scan']) {
      const run = spawnSync(process.execPath, [`scripts/audit/${script}.mjs`, file, '--ceiling', '50'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const rows = run.stdout.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(rows[0].kind, 'coverage');
      assert.equal(rows[0].accepted, 2);
      assert.equal(rows[0].duplicates, 1);
      assert.equal(rows[0].researchExcluded, 1);
      const results = rows.filter(row => row.kind === 'result');
      assert.equal(results.length, 3);
      assert.deepEqual(results[0].mix, { read: 160, write: 40, output: 20 });
      if (script === 'context-ceiling-replay') assert.equal(results[0].modelled.inputTokens, 100);
      if (script === 'polling-scan') assert.equal(results[0].observed.polls, 2);
      assert.equal(await readFile(file, 'utf8'), source);
    }
    const short = spawnSync(process.execPath, ['scripts/audit/composition-scan.mjs', file, '--repeats', '2'], { encoding: 'utf8' });
    assert.notEqual(short.status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
