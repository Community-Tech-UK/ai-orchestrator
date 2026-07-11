#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const yaml = require("js-yaml");

const MANIFEST_PAYLOADS = {
  "latest-mac.yml": (version) => [
    `Harness-${version}-mac-arm64.zip`,
    `Harness-${version}-mac-x64.zip`,
  ],
  "latest.yml": (version) => [`Harness-${version}-win-x64.exe`],
  "latest-linux.yml": (version) => [`Harness-${version}-linux-x64.AppImage`],
  "latest-linux-arm64.yml": (version) => [
    `Harness-${version}-linux-arm64.AppImage`,
  ],
};

function requiredReleaseAssetNames(version) {
  return [
    `Harness-${version}-mac-arm64.dmg`,
    `Harness-${version}-mac-arm64.dmg.blockmap`,
    `Harness-${version}-mac-arm64.zip`,
    `Harness-${version}-mac-arm64.zip.blockmap`,
    `Harness-${version}-mac-x64.dmg`,
    `Harness-${version}-mac-x64.dmg.blockmap`,
    `Harness-${version}-mac-x64.zip`,
    `Harness-${version}-mac-x64.zip.blockmap`,
    `Harness-${version}-win-x64.exe`,
    `Harness-${version}-win-x64.exe.blockmap`,
    `Harness-${version}-linux-x64.AppImage`,
    `Harness-${version}-linux-arm64.AppImage`,
    "latest-mac.yml",
    "latest.yml",
    "latest-linux.yml",
    "latest-linux-arm64.yml",
  ];
}

function validateReleaseAssetNames(names, version) {
  const errors = [];
  const available = new Set(names);
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) errors.push(`Duplicate release asset: ${name}`);
    seen.add(name);
  }
  for (const required of requiredReleaseAssetNames(version)) {
    if (!available.has(required))
      errors.push(`Missing release asset: ${required}`);
  }
  for (const name of names) {
    if (/REPLACE|placeholder/i.test(name)) {
      errors.push(`Release assets contain a placeholder name: ${name}`);
    }
  }
  return errors;
}

function releaseAssetNameFromUrl(url) {
  const pathWithoutQuery = url.split(/[?#]/u, 1)[0];
  return path.posix.basename(pathWithoutQuery);
}

function validateReleaseManifestContents(
  manifests,
  names,
  version,
  assetSha512ByName = {},
) {
  const errors = [];
  const available = new Set(names);

  for (const [manifestName, expectedPayloadsForVersion] of Object.entries(
    MANIFEST_PAYLOADS,
  )) {
    const raw = manifests[manifestName];
    if (typeof raw !== "string") {
      errors.push(`Missing update manifest contents: ${manifestName}`);
      continue;
    }

    let manifest;
    try {
      manifest = yaml.load(raw);
    } catch {
      errors.push(`${manifestName} is not valid YAML`);
      continue;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      errors.push(`${manifestName} must contain a YAML object`);
      continue;
    }

    if (manifest.version !== version) {
      errors.push(
        `${manifestName} has version ${String(manifest.version)}; expected ${version}`,
      );
    }

    const expectedPayloads = new Set(expectedPayloadsForVersion(version));
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    if (files.length === 0) {
      errors.push(`${manifestName} has no update files`);
    }
    const referencedAssets = new Set();
    const seenUrls = new Set();
    for (const file of files) {
      if (!file || typeof file !== "object" || Array.isArray(file)) {
        errors.push(`${manifestName} contains an invalid file entry`);
        continue;
      }
      const url = typeof file.url === "string" ? file.url : "";
      if (!url) {
        errors.push(`${manifestName} contains a file without a URL`);
        continue;
      }
      if (/REPLACE|placeholder/iu.test(url)) {
        errors.push(`${manifestName} references a placeholder URL: ${url}`);
      }
      if (seenUrls.has(url)) {
        errors.push(`${manifestName} contains a duplicate URL: ${url}`);
      }
      seenUrls.add(url);

      const assetName = releaseAssetNameFromUrl(url);
      referencedAssets.add(assetName);
      if (!available.has(assetName)) {
        errors.push(
          `${manifestName} references an unpublished asset: ${assetName}`,
        );
      }
      if (typeof file.sha512 !== "string" || file.sha512.trim() === "") {
        errors.push(`${manifestName} file ${assetName} is missing sha512`);
      } else if (
        typeof assetSha512ByName[assetName] === "string" &&
        file.sha512 !== assetSha512ByName[assetName]
      ) {
        errors.push(`${manifestName} checksum does not match ${assetName}`);
      }
      if (!expectedPayloads.has(assetName)) {
        errors.push(
          `${manifestName} references unexpected update payload ${assetName}`,
        );
      }
    }

    for (const expectedPayload of expectedPayloads) {
      if (!referencedAssets.has(expectedPayload)) {
        errors.push(`${manifestName} does not reference ${expectedPayload}`);
      }
    }
  }

  return errors;
}

function main() {
  const directory = path.resolve(process.argv[2] ?? "release-assets");
  const version =
    process.argv[3] ??
    JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
    ).version;
  const names = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const manifests = Object.fromEntries(
    Object.keys(MANIFEST_PAYLOADS)
      .filter((name) => names.includes(name))
      .map((name) => [
        name,
        fs.readFileSync(path.join(directory, name), "utf8"),
      ]),
  );
  const updatePayloadNames = Object.values(MANIFEST_PAYLOADS).flatMap(
    (payloadsForVersion) => payloadsForVersion(version),
  );
  const assetSha512ByName = Object.fromEntries(
    updatePayloadNames
      .filter((name) => names.includes(name))
      .map((name) => [
        name,
        crypto
          .createHash("sha512")
          .update(fs.readFileSync(path.join(directory, name)))
          .digest("base64"),
      ]),
  );
  const errors = [
    ...validateReleaseAssetNames(names, version),
    ...validateReleaseManifestContents(
      manifests,
      names,
      version,
      assetSha512ByName,
    ),
  ];
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(`Validated ${names.length} release assets for ${version}`);
}

if (require.main === module) main();

module.exports = {
  requiredReleaseAssetNames,
  validateReleaseAssetNames,
  validateReleaseManifestContents,
};
