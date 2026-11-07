# Pilot evidence recovery, 27 October 2026

**All thirty paid A/D/G candidate patches can now be replayed; the eighteen missing later full runner records remain missing.** This pass rebuilt the thirty candidates deterministically from their original edit actions and recovered two final C2 coder diff snapshots. It did not recover original runner patch files or fabricate missing records.

## What is usable

| Evidence | Result | Provenance limit |
| --- | --- | --- |
| All ten A, ten D and ten G candidates | Thirty valid regenerated patches | Exact chronological transcript edits replayed against each task's recorded parent. Each entire regenerated diff, after the exact historical attribution and blank-line scrub, equals a complete surviving original judge input, including Git file hashes and hunks. These are transcript reconstructions, not recovered original runner patches. |
| 12ST-02 C2 and AIO-01 C2 | Two untruncated final coder `git diff` snapshots; both parse | No subsequent tool calls occur in either transcript. Verbatim output slices are retained. The `.patch` copies add a final newline only. Runner capture used `git add -A` and `git diff --cached`, so a coder's tracked diff is not independently proved to be the complete runner patch. |
| Eight later C1 and ten C2 full records | None recovered | Existing execution summaries and agent activity do not replace full records. |
| All 32 retained scored candidates | Thirty nonempty patches fail structural parsing; two C1 candidates are empty | Exact retained bytes were copied without repair. The older A/D/G files are attribution-stripped judge embeddings. Their original blank lines are absent. |

The thirty reconstruction patches are in `transcript-reconstruction/A/`, `D/` and `G/`. [candidate-manifest.json](candidate-manifest.json) lists all thirty, the two retained empty C1 candidates and the two diagnostic-only C2 snapshots, with repository-relative paths, hashes and provenance receipts. Every listed hash was checked against the saved file.

The complete edit payloads, original source-row hashes, reconstructed source-file hashes and checks are in [aio01-transcript-reconstruction.receipt.json](aio01-transcript-reconstruction.receipt.json) and [remaining-transcript-reconstruction.receipt.json](remaining-transcript-reconstruction.receipt.json). No full source trees are retained. The replay scripts interpret only captured text operations against virtual files; they never execute historical shell commands. Captured formatter operations run the installed formatter on stdin only, then require exact final-input equality. Historical subprocess imports are replaced by a virtual implementation that permits only listing changed TypeScript paths and applying that formatter. Model calls and historical test commands cannot run through it.

Temporary stash/check/pop and explicit backup/restore probes are omitted as net no-ops. Two failed edit attempts recur during replay, for 12ST-04 D and AIO-06 G; [historical-failed-attempts.receipt.json](historical-failed-attempts.receipt.json) confirms the same original assertion/context failures in the source outputs. Later captured actions produce the exact final judge inputs. Original, unnormalized tool inputs are used for source bytes: one normalized duplicate had changed a literal Unicode separator into an escape sequence.

The exact historical judge transform is preserved in [strip_judge.cjs](strip_judge.cjs). Besides dropping blank lines, it removes comments and other lines matching its provider-attribution patterns. It can even remove a `---` diff header containing a provider name. Applying that complete known transform, rather than restoring or guessing whitespace, is necessary for the comparison.

The two C2 snapshots and their source identities are described in [recovered-coder-diffs.receipt.json](recovered-coder-diffs.receipt.json). AIO-02 C2 also printed a diff, but that result is explicitly truncated and was not promoted to a patch.

All 32 retained candidates are copied under `retained-candidates/`; [all32-patch-validity.receipt.json](all32-patch-validity.receipt.json) records each source name, hash, size and exact Git parser output. A parser check does not test behavior. The two empty C1 files represent no patch content, rather than a successful nonempty patch parse.

## Searches and negative results

1. Rechecked both historical checkpoint branches: fourteen benchmark-changing checkpoint trees and 51,028 historical Git objects contain no named pilot session, `runs.jsonl`, `runs-quarantined.jsonl` or `run1.patch` object paths. Their branch reflogs contain eleven and seven entries; no additional detached checkpoint tip was exposed there.
2. Read every tree and blob reported by `git fsck --unreachable --no-reflogs --no-progress`: 10,220 trees and 4,071 blobs, totaling 310,975,727 bytes. There were no tree-entry matches for the pilot record/patch names, no blob containing literal `"patchPath"` plus literal `"C1"` or `"C2"`, and no blob starting with a raw history unified diff. `fsck` exited 8 because of an existing malformed `refs/.DS_Store`; the receipt retains that error. This is a result for the objects it reported, not a claim of universally complete enumeration.
3. Checked all eighteen known later-run Claude transcripts for captured `git diff` commands and results. Only the two usable final snapshots above and the explicitly truncated AIO-02 C2 diff were found. The AIO-01 C2 historical `git log -p` output is baseline history, not its candidate patch.
4. Checked 81 compressed Codex sessions on 15–16 October to locate the two AIO-01 G contexts. A/D coder transcripts and those G contexts retain enough exact source edits for the deterministic replay. Their restricted source-file diff prints alone do not provide original complete runner stdout.
5. Re-read the 51 historical Claude judge transcript files. The complete AIO-01 A/D/G embedded diffs are exactly the retained stripped contents; recovering the outer fences does not restore blank lines. No whitespace-restored judge patch was presented as an original.

The earlier recovery pass already searched the original worker's captured OpenCode output and Harness ledger for full records and C2 patch dumps. This pass read its receipts and extended the search rather than repeating those same queries.

The root portable mirror still contains A10/D10/G10/C1=2 scored records and fourteen quarantined C1 records. No missing record was merged into that mirror. The existing C1 patch names cannot establish identity with later missing attempts.

## Verification and remaining limits

- Git parsed all thirty transcript reconstruction patches and both newline-terminated coder snapshot patches successfully. The complete original A/D/G judge inputs exactly match the reconstructed diffs after the complete known historical judge transform.
- No behavioral scoring, model inference, browser action, remote change, paid call, branch/worktree operation or production-source edit was performed in this subtask. Behavioral scoring belongs to the separate scoring work.
- The full eighteen-record gap remains open. Two missing C2 cells now have final tracked-diff evidence, but neither has a full runner record or independently matched original runner patch file.
- This bounded search did not inspect external backups or remote machines and does not exclude arbitrary encodings or compressed Git blob payloads. Historical database queries were not repeated after the prior pass documented their negative result.

Recovery checklist: Git/history search complete within the recorded bounds; all thirty A/D/G transcript reconstructions complete; all thirty-two retained candidates structurally inventoried; manifest complete. Original full-record recovery for the eighteen later C1/C2 cells remains unsuccessful. Rescoring belongs to the separate scoring work and is not claimed here.

Machine receipts record the exact commands, filters, counts and hashes. Artifact paths are repository-relative; absolute `source` fields identify the original local provenance only. No original evidence was overwritten.
