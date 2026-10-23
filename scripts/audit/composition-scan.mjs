// Read-only: label observed/modelled; print coverage first; >=3 repeats; ±3% noise;
// exclude research sweeps; deduplicate message ID; report read/write/output mix.
import { runAudit } from './measurement-kit.mjs';
await runAudit('composition-scan');
