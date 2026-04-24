#!/usr/bin/env node

function parseMajor(v) {
  const m = String(v || '').match(/^v?(\d+)/);
  return m ? Number(m[1]) : 0;
}

const requiredMajor = 22;
const major = parseMajor(process.version);
if (major < requiredMajor) {
  // Keep this short; npm may be running under an older node too.
  // eslint-disable-next-line no-console
  console.error(`Node ${requiredMajor}+ required. Detected ${process.version}.`);
  // eslint-disable-next-line no-console
  console.error('If you use nvm: `nvm use` (see .nvmrc).');
  process.exit(1);
}

