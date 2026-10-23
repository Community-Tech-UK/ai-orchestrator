#!/usr/bin/env node
/**
 * H1: name/tooltip; H2: unchanged native-title migration; H3: one hover host;
 * H4: keyboard reachability or exact reason; H5: shortcut channel; H6: used copy;
 * H7/H8: reports; H9: keep words or retire with a reviewable reason;
 * H10: semantic controls; H11: authored HTML/title surfaces; H12: honest measurement.
 * See docs/screen-and-wording-guide.md, section 5. Records are changed only by
 * --init, --tighten, --transfer, --exempt, --record-wording or --retire.
 */
import { runCheck } from './ui-hints/cli';
const result = runCheck(process.argv.slice(2));
process.stdout.write(result.output);
process.exitCode = result.exitCode;
