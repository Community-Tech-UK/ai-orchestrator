#!/usr/bin/env node
// Claude CLI PreCompact hook for Harness's own work (plan queue, loops, scheduled jobs).
//
// VERIFIED against the installed CLI 2.1.304: a PreCompact command hook that exits 0
// has its stdout added to the compaction instructions (`newCustomInstructions`), so
// what is printed here tells the summariser what to keep. Only exit code 2 blocks
// compaction; this hook always exits 0, so it can never stop one.
//
// The role arrives as argv[2]. Any other role prints nothing.
import { readFileSync } from 'fs';

const KEEP_LAST = 'Drop old tool output and finished detail before anything listed here.';
const BLOCKS = {
  'queue-worker': [
    'When you summarise, keep the following in at most 1,200 characters:',
    '- the job, and the plan file path;',
    '- the files you changed, as paths;',
    '- the last check you ran, and whether it passed;',
    '- the next step, and what is already done so you do not repeat it.',
    KEEP_LAST,
  ],
  loop: [
    'When you summarise, keep the following in at most 1,200 characters:',
    '- the open task ids from the loop task list, and the loop state folder path;',
    '- the goal, and the plan file path;',
    '- the files you changed, and the last check result;',
    '- the next step, and what is already done so you do not repeat it.',
    KEEP_LAST,
  ],
  automation: [
    'When you summarise, keep the following in at most 1,200 characters:',
    '- what this scheduled task is for and what it must deliver;',
    '- what is done and what is left;',
    '- the files or places you changed or sent output to, as paths;',
    '- the next step, and what is already done so you do not repeat it.',
    KEEP_LAST,
  ],
};

// Drain stdin (the CLI writes the hook input there) so it never sees a closed pipe.
try { readFileSync(0); } catch { /* no input is fine */ }

const role = process.argv[2];
const block = Object.hasOwn(BLOCKS, role) ? BLOCKS[role] : undefined;
if (block) process.stdout.write(`${block.join('\n')}\n`);
process.exit(0);
