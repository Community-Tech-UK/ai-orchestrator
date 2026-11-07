# Local pilot livetest resume 2 — 2026-11-07

Short receipt for the evidence run recorded in the livetest document (dated section "Evidence run — 2026-11-07 (resume 2, Plan Queue worker)").

- Merge check: `git merge-tree --write-tree HEAD main` exited 0 (tree 21a5e28b). No merge performed.
- Read-only Windows check (windows-pc): LM Studio helper IDLE, context 229376, parallel 2; listeners 1235/8900/8901/11434 absent; PCIe gen 1 x16 at idle.
- Routing setting read back: `local-first`.
- Key transfer: configured key present in Bitwarden (64 characters, SHA-256 prefix 6f42c996). Upload refused twice by the transfer route (restricted source / outside workspace). No rename or alternate route used. Local plaintext copies deleted; Bitwarden locked; remote existence check: key file absent.
- No native server started, no inference, no cloud call, no score.
- Remote diagnostic instances terminated.
- Residual (unchanged from 7 Nov): windows-pc `plan-ex-ab-security-20261107` holds server.pid and two log files, no key material.
