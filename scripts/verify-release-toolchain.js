#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const MINIMUM_APP_BUILDER_LIB_VERSION = [26, 15, 0];

function parseStableVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function isAtLeast(version, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] > minimum[index]) return true;
    if (version[index] < minimum[index]) return false;
  }
  return true;
}

function validateReleaseToolchain(packages) {
  const builders = Object.entries(packages).filter(([packagePath]) =>
    packagePath === "node_modules/app-builder-lib"
    || packagePath.endsWith("/node_modules/app-builder-lib"),
  );
  if (builders.length === 0) {
    return ["package-lock.json does not contain app-builder-lib"];
  }

  const errors = [];
  for (const [packagePath, entry] of builders) {
    const version = entry.version ?? "";
    const parsedVersion = parseStableVersion(version);
    if (!parsedVersion) {
      errors.push(`${packagePath} has an invalid app-builder-lib version: ${version}`);
      continue;
    }
    if (!isAtLeast(parsedVersion, MINIMUM_APP_BUILDER_LIB_VERSION)) {
      errors.push(
        `${packagePath} locks vulnerable app-builder-lib ${version}; require >=26.15.0`,
      );
    }
  }
  return errors;
}

function main() {
  const packageLock = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "package-lock.json"), "utf8"),
  );
  const errors = validateReleaseToolchain(packageLock.packages ?? {});
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log("Release toolchain policy passed: app-builder-lib >=26.15.0");
}

if (require.main === module) main();

module.exports = { validateReleaseToolchain };
