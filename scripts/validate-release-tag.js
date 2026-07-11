#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function validateReleaseTag(tag, version) {
  const errors = [];
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    errors.push(
      `Release tag must be a stable semantic version in vX.Y.Z form: ${tag}`,
    );
  }
  if (tag !== `v${version}`) {
    errors.push(`Tag ${tag} does not match package version ${version}`);
  }
  return errors;
}

function main() {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
  );
  const errors = validateReleaseTag(tag, packageJson.version);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Release tag ${tag} matches package version ${packageJson.version}`,
  );
}

if (require.main === module) main();

module.exports = { validateReleaseTag };
