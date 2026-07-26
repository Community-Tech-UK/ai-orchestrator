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
  if (parsed.major === 22) return isAtLeast(parsed, 22, 3);
  if (parsed.major === 24) return isAtLeast(parsed, 15, 0);
  return parsed.major === 26;
}

if (require.main === module && !isSupportedNodeVersion(process.version)) {
  // Keep this short; npm may be running under an unsupported Node version too.
  // eslint-disable-next-line no-console
  console.error(
    `Node ^22.22.3, ^24.15.0, or ^26.0.0 required. Detected ${process.version}.`,
  );
  // eslint-disable-next-line no-console
  console.error('If you use nvm: `nvm use` (see .nvmrc).');
  process.exit(1);
}

module.exports = { isSupportedNodeVersion };
