# Generate the mobile gateway TLS test fixture at runtime

Status: COMPLETED18October2026, uncommitted, after canonical seven and genuinely new independent [VERDICT: PASS](../../_scratch/changed-plans-queue-2026-10-18/document-status-tls-fresh-gate/FINAL-REPORT.md). Test-only health follow-up; no production credential incident and not introduced by Phase0.

The gateway integration spec previously contained a literal self-signed private key. It now generates a fresh test-only certificate/key pair once in an awaited test hook. The real HTTPS handshake, hostname extraction, unreadable-path fallback, assertions, cleanup and production TLS behavior are preserved.

Use the already installed/locked selfsigned5.5.0 generator as an explicitly declared direct development dependency. Do not implement cryptographic serialization or change resolved package versions. Risks: async fixture readiness, DNS/IP SAN preservation, validity dates, compatible matching key/certificate and cleanup. Existing real server tests plus safe certificate metadata/key-match checks cover these.

- [x] Record the current static-private-key policy failure without exposing key bytes; read complete affected source, API and callers.
- [x] Add only the exact direct development declaration in package.json and root lock metadata; independently compare every other lock entry and package-manifest field unchanged.
- [x] Replace the static PEM fixture with awaited runtime EC P-256/SHA-256 generation, explicit DNS/IP SANs and runtime-relative validity. Write temporary key files with restricted mode.
- [x] Verify real TLS/hostname/fallback tests, certificate metadata/key pairing and the entire existing server spec; preserve every existing assertion.
- [x] Refresh the health review's affected-source secret scan, dependency/audit reconciliation and exact-state guards.
- [x] Run all seven canonical project gates, including actual full Vitest close, and obtain a new independent task-completion-gate PASS covering this change and the document-status memory correction.
- [x] Update as-built evidence and close this plan only after all required checks pass.

Evidence lives in `_scratch/changed-plans-queue-2026-10-18/tls-fixture-policy-preparation/`, `large-status-health-escalation/` and the combined `document-status-memory-verification/`. Preserve prior failure evidence and closed historical documents. No branch/worktree, staging, commit, push, application/browser action or credential lookup is required.

Manifest evidence: `tls-fixture-policy-preparation/manifest-correction.json` records only exact direct dev declaration selfsigned5.5.0 in both root manifests. All other manifest fields and all1,604 parsed lock entries/fields are equal; no resolved version change, package installation or dependency-tree mutation. The awaited runtime fixture and existing focused/whole-file integration checks now pass.

Runtime evidence: pinned Node24.15.0 focused TLS/hostname cases and entire99-case server spec both have observed actual Vitest close0/no signal, quiet wrapper0 and no known owned PIDs remaining. Safe metadata from the real temporary key writes proves EC P-256, matching certificate/private key, valid self-signature, DNS/IP SANs, current short validity, mode0600 and removal of both temporary directories. An initial outer wrapper failed when process-list access was denied; its result is retained as INVALID RUN EVIDENCE, not PASS. Separate corrected invocations supply the passing receipts. Root read both command receipts, safe metadata, observer/runner and the PEM-redacted source diff.

## Final as-built acceptance,18October2026

The runtime-only fixture replaces the static PEM. Both root manifests declare exact existing selfsigned5.5.0 directly for tests; every other manifest field/all1,604lock entries and resolved versions are equal. Independent lock-exact clean npmci0, full installed content/link/mode equivalence and official exact-pin/nondeprecated/integrity checks pass; its23-node runtime dependency closure has no advisory in the current retained audit. Shared dependencies were never replaced. Existing reviewed broader advisories remain explicit baseline risks.

Current normal and independent canonical seven all pass. Independent actual full10264closed19:44:11.493Z0/no signal with34,155passed/0failed/seven identical historical skips. Independent207focused cases include the whole99-case server file. All314assertion chains are equivalent,313byte-identical and1fixture-name substitution. A distinct post-full actual TLSmetadata child29295closed0/no signal; actual key writes prove P256/ECDSA-SHA256, matching cert/key+self-signature, DNS/IP SANs, current24h validity, mode0600 and cleanup. Existing rejectUnauthorized:false remains scoped to self-signed integration behavior, not trusted-client validation.

The final79-artifact seal/report were personally read/rehashed by root with0mismatch: report SHA256a0dde90bc04bad2c3be170522efafd2897954c6d8116f36e8c72721f23235d6e; seal SHA256c516be60924f81ea5c860b61d3d4d87d6dc9ce420ff376859dbbf62652fe06ba. Source/config/dependency/Git/index/assets guards match; all owned processes closed. Collector setup failures remain retained and qualified, corrected reconciliations actually0. Health all0–6passes complete; affected scans0findings do not erase historical broad scan findings.

One parent historical-diff redactor failed and printed the old disposable fixture in a tool result; James was told and the filter was corrected. No production/account credential exposure or rotation incident was established. Safe retained reports contain no PEM/private/generated-key bytes. This test-only correction requires no installed-app adoption or invented live deferral. All required items checked before this filename closes.
