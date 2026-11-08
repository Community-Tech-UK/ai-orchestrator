   unqueued sends keep their audit receipts; enriched provider text is unchanged.
2. **Worker imports:** the WAL helper moved unchanged into the existing schema
   module and obsolete rlm-wal.ts was removed. Closure is 155, with zero Electron
   value-importers. The strict <156 assertion and import guards are unchanged.
   Baseline focused run failed at 156; the same three-file run now passes.
3. **Dependencies:** compatibility failed before repair. Only 12 confirmed
   extraneous local package directories absent from the branch lockfile were
   removed. Manifests, lockfile, versions, test settings and thresholds were not
   changed. A prune dry run proposed unrelated upgrades and was not applied.
   Compatibility now passes.

Queue regressions cover exact identity after more than 60 seconds, wrong instance
and origin, cancelled/claimed rows, enriched receipt ownership, rejected claim
preventing native writes, null CAS, genuine unsent recovery, concurrent drains,
Pause on the same admission, native command passthrough and retry behavior.

