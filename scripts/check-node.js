#!/usr/bin/env node

function parseVersion(version) {
  const match = String(version || '').match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isAtLeast(version, requiredMinor, requiredPatch) {
  return (
    version.minor > requiredMinor ||
    (version.minor === requiredMinor && version.patch >= requiredPatch)
  );
}

function isSupportedNodeVersion(version) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  // Floors are the October 2026 Node.js security releases (CVE-2026-111497).
  if (parsed.major === 22) return isAtLeast(parsed, 23, 4);
  if (parsed.major === 24) return isAtLeast(parsed, 22, 1);
  if (parsed.major === 26) return isAtLeast(parsed, 12, 1);
  return false;
}

if (require.main === module && !isSupportedNodeVersion(process.version)) {
  // Keep this short; npm may be running under an unsupported Node version too.
  // eslint-disable-next-line no-console
  console.error(
    `Node ^22.23.4, ^24.22.1, or ^26.12.1 required. Detected ${process.version}.`,
  );
  // eslint-disable-next-line no-console
  console.error('If you use nvm: `nvm use` (see .nvmrc).');
  process.exit(1);
}

module.exports = { isSupportedNodeVersion };
