#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

function mergeUpdateManifestObjects(manifests) {
  if (manifests.length < 2)
    throw new Error("At least two update manifests are required");
  const version = manifests[0]?.version;
  if (!version || manifests.some((manifest) => manifest.version !== version)) {
    throw new Error("Update manifests must describe the same version");
  }

  const filesByUrl = new Map();
  for (const manifest of manifests) {
    for (const file of manifest.files ?? []) {
      if (!file?.url)
        throw new Error("Every update manifest file requires a URL");
      filesByUrl.set(file.url, file);
    }
  }
  const { path: _path, sha512: _sha512, ...sharedManifest } = manifests[0];
  return { ...sharedManifest, files: [...filesByUrl.values()] };
}

function main() {
  const [output, ...inputs] = process.argv.slice(2);
  if (!output || inputs.length < 2) {
    throw new Error(
      "Usage: merge-update-manifests.js <output.yml> <input-a.yml> <input-b.yml> [...]",
    );
  }
  const manifests = inputs.map((input) =>
    yaml.load(fs.readFileSync(path.resolve(input), "utf8")),
  );
  fs.writeFileSync(
    path.resolve(output),
    yaml.dump(mergeUpdateManifestObjects(manifests)),
    "utf8",
  );
  console.log(
    `Merged ${inputs.length} update manifests into ${path.basename(output)}`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { mergeUpdateManifestObjects };
