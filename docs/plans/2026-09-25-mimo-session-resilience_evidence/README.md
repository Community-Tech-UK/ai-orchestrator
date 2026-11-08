# MiMo evidence retention, 27 October 2026

This directory retains historical observations and command receipts. The current
correction and its new verification are owned by the coordinator. This retention
change runs no test or live check and makes no new completion claim.

## What remains portable

- All 256 smaller original files remain byte-identical: live native/UI/network
  observations, monitor readings, controlled-cookie method receipts, negative
  controls, command exits, reviews, cleanup receipts and historical seals.
- [Portable suite summaries](portable-suite-summaries.json) replace nine large,
  duplicative suite JSON/log files. They retain literal runner counters, file and
  assertion status counts, non-passing test names, final footer lines, dependency
  failure and unhandled-error diagnostics, and actual process exits. Counts are
  not repaired to make inconsistent historical totals add up. JSON suite totals
  are not file totals; JSON `success: true` does not override process exit 1.
- [Historical hook evidence](post-merge-hook-evidence-summary.json) indexes all
  44 original command receipts with exact exits and historical output hashes.
  Small compressed targeted-run outputs and JSON reports remain portable in
  [the original runner directory](2026-10-27-post-merge-hook/raw-test-receipts/).
  The summary records red/green worker/hook/finality results and failure names;
  inferred command-to-runner correspondence is explicitly qualified.
- [The retention manifest](retention-manifest.json) maps every relocated file to
  its original and decompressed SHA-256, exact byte size, ignored local archive
  and portable summary. It also records preservation checks for the other files.

The historical post-merge `.log` command outputs were already absent from this
checkout; the matching root evidence directory was absent too. They cannot be
recovered from a hash. No missing text or excerpt has been recreated. Original
command receipts and seals remain authoritative for their recorded exits. The
historical final hook replay records exit 0 and an unchanged real index, but the
report's 312-file / 6,375-test counts cannot be independently re-extracted from
that absent output. The smaller retained runner outputs establish their own
focused results, not the missing full staged-run output. Later source review
rejected the unconditional build, so that historical hook success does not
validate the new correction.

## Local raw archive and history

Nine original files totalling **8,910,490 bytes** moved out of the portable tree.
Their complete bytes are preserved, without checkout or dependency copies, in
`_scratch/mimo-evidence-retention-2026-10-27/` relative to the assigned worktree.
That path is Git-ignored and will not be harvested. Each stored hash was compared
with the original and its earlier receipt; compressed payloads were decompressed
and checked before their original paths were removed. The archive includes a
pre-retention inventory to check every preserved original again. The remaining
256 original files occupy **552,345 bytes**; derived summaries add a small amount.
This reduces the current tree and future evidence copies, not bytes already in
Git history. Scratch is local and disposable; the portable summaries deliberately
do not claim to retain every emitted test line.

Every historical seal remains unchanged. A seal's relocated entries describe the
old bytes and old locations. Follow the manifest for those bytes; do not treat an
old seal as a hash of a derived summary or a later source/report revision. The new
correction directory is outside this retention operation and its byte accounting.

## Outcomes and limits retained

The review-fixes interrupted suite remains exit **143**; its subsequent final
suite remains exit **0**, with 35,373 passed and nine pending tests. The post-merge
load-interrupted suite remains exit **143**. Its original-dependency full suite
remains exit **1** with one assertion failure and an unhandled source-map error.
The isolated-dependency suite also remains exit **1**, despite JSON success and
zero reported assertion failures, because of the unhandled source-map error.
Its subsequent pinned-runtime suite remains exit **0**, with 35,375 passed and
nine pending tests. These are historical outcomes, not fresh gates.

No acceptance evidence was replaced with a fabricated rerun. In particular,
Check 4 retains the indirect **4 October** snapshot-timestamp cadence observation,
not a new request capture. Renewal used controlled outgoing-cookie exclusion,
not observed natural expiry; the visual notification and locked-database recovery
remain unobserved. Existing live observations, negative controls and their stated
qualifications are unchanged.
