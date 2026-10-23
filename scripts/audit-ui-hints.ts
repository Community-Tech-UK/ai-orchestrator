#!/usr/bin/env node
import { runAudit } from './ui-hints/cli';
const result = runAudit(process.argv.slice(2));
process.stdout.write(result.output);
process.exitCode = result.exitCode;
