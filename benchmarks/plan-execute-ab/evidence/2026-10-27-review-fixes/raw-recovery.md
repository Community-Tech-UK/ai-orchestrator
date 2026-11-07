# Missing pilot record recovery

Observed: 2026-10-27T13:53:59.341051+00:00.

No original full runner records or final patches were recovered for the eight later C1 and ten C2 runs. The checked sources retain agent transcripts and recorded scoring summaries. These cannot replace the missing records or establish the complete final patch contents.

## Checked sources and results

- The root portable session mirror has 32 records: A=10, D=10, G=10, C1=2. Its two C1 records are 12ST-01 and 12ST-02 from 24 October. Its quarantine mirror has 14 records, all C1.
- Both root benchmark scratch directories were searched recursively for JSONL files and C2 patches. Only the retained `runs.jsonl` and `runs-quarantined.jsonl` were present; no C2 patch was present.
- The original `01472a` worktree no longer exists. This current worktree has no pilot scratch session. `/private/tmp/plan-execute-ab` retains only the unrelated AIO-03 B workspace.
- `rtk proxy git ls-tree -r --name-only 9cc19c6d6c57267566cace5dac0d1999beb57780 -- _scratch` exited successfully with empty output. This checks that checkpoint tree, not every unreachable Git object.
- Read 9040 original OpenCode parts associated with experiment worktrees, including 1567 since 24 October 23:00 UTC. Captured outputs contained no C2 patch path and no full C1/C2 record containing `patchPath`.
- Read 807 associated Harness conversation-ledger messages for the old worktree. No C2 patch dump or full C1/C2 record containing `patchPath` was found.
- The manifest's eight later C1 and ten C2 agent transcripts still exist and their current hashes match the retained manifest. These are agent activity transcripts, not runner scoring records or final patches.

The machine receipt records actual counts, source file hashes, exact SQL filters, timestamped original rows and their hashes. `originalSourceRows` preserves the captured command and output; `parsedInterpretations` explicitly separates our interpretation.

## Earlier AIO-01 attempt must stay separate

At **25 October 00:43:52.400 UTC**, original OpenCode part `prt_170838ed0001tezDVv1L54VLFb` printed a projection of the last run: AIO-01 C1, **154057 ms, 13 turns**, with a `vitest/vitest.mjs` scoring crash and failed damage checks. It printed 33 records at that point. It was not a full runner record: the projection omitted fields including timestamps and patch path.

At **00:59:26.246 UTC**, original part `prt_17091cea6001lJ4j3I7qi0uCCC` selected that last AIO-01 C1 record, attached the scoring-environment quarantine reason, removed it from scored runs and appended it to quarantine. Its captured successful output was `quarantined; runs.jsonl now 32 records`. These are historical command contents, not commands executed by this investigation.

At **05:37:01.224 UTC**, part `prt_1718ff1280010Jyq6v3PN6nnhy` printed the later eight C1 summaries. The later AIO-01 entry was **60 minutes, 9 turns, failed hidden check, clean damage, wall clock limit**. Therefore the earlier 13-turn scoring crash cannot be used to assert that the later 0/10 C1 matrix contains that crash. Full later scoring output remains missing.

At **08:33:11.922 UTC**, part `prt_172313cf2001B9dqS3P76TcCBN` printed all ten C2 summaries and the aggregate matrix. It did not print full records or patches.

The 12ST-03 later C1 receipt `prt_1716bd747001ldTvZXVo8t8eEs` contains only truncated check output: its damage check exited 2 and begins `home.component.spec.ts(19,8): TS2307: Cannot find...`. It does not supply a complete hidden-test result log.

## Rerun the bounded queries

All database connections below are read-only. They print identifiers and counts, not entire stored sessions. The exact original rows can be retrieved using the parameterized `originalRowsSql` and identifiers in the JSON receipt.

```bash
rtk proxy python3 - <<'PYQUERY'
import json, sqlite3
from pathlib import Path
r = json.loads(Path('benchmarks/plan-execute-ab/evidence/2026-10-27-review-fixes/raw-recovery.receipt.json').read_text())
q = r['sourceQueries']
c = sqlite3.connect('file:' + q['openCodeDatabase'] + '?mode=ro', uri=True)
rows = list(c.execute(q['allExperimentPartsSql']))
later = list(c.execute(q['laterPartsSql']))
print('experiment parts:', len(rows), 'later parts:', len(later))
patch_hits, record_hits = [], []
for part_id, session_id, created, data in rows:
    output = json.loads(data).get('state', {}).get('output', '')
    if not isinstance(output, str):
        continue
    if 'C2-run1.patch' in output:
        patch_hits.append(part_id)
    if '"patchPath"' in output and ('"C1"' in output or '"C2"' in output):
        record_hits.append(part_id)
print('C2 patch outputs:', patch_hits)
print('C1/C2 full-record output candidates:', record_hits)
l = sqlite3.connect('file:' + q['ledgerDatabase'] + '?mode=ro', uri=True)
ledger = list(l.execute(q['ledgerSql']))
print('ledger messages:', len(ledger))
for row in r['originalSourceRows']:
    found = c.execute(q['originalRowsSql'], (row['id'],)).fetchone()
    import hashlib
    print(row['id'], 'original row hash matches:', hashlib.sha256(found[3].encode()).hexdigest() == row['sourceDataUtf8Sha256'])
PYQUERY
```

## Limits

This is a bounded recovery result. It does not prove that every possible backup or unreachable Git blob lacks the evidence. No remote machine or external backup was searched. Literal field searches do not exclude arbitrary encodings or compressed payloads. The SQLite files can change while Harness runs; hashes identify selected original row text and dated source files, not an immutable live database snapshot. Existing C1 patch names do not prove those bytes belong to the later runs. No missing runner records or patches were synthesized.
