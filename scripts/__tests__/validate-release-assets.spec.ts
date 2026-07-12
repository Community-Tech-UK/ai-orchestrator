import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { validateReleaseAssetNames, validateReleaseManifestContents } =
  require("../validate-release-assets.js") as {
    validateReleaseAssetNames: (names: string[], version: string) => string[];
    validateReleaseManifestContents: (
      manifests: Record<string, string>,
      names: string[],
      version: string,
      assetSha512ByName?: Record<string, string>,
    ) => string[];
  };

const COMPLETE = [
  "Harness-1.2.3-mac-arm64.dmg",
  "Harness-1.2.3-mac-arm64.dmg.blockmap",
  "Harness-1.2.3-mac-arm64.zip",
  "Harness-1.2.3-mac-arm64.zip.blockmap",
  "Harness-1.2.3-mac-x64.dmg",
  "Harness-1.2.3-mac-x64.dmg.blockmap",
  "Harness-1.2.3-mac-x64.zip",
  "Harness-1.2.3-mac-x64.zip.blockmap",
  "Harness-1.2.3-win-x64.exe",
  "Harness-1.2.3-win-x64.exe.blockmap",
  "Harness-1.2.3-linux-x64.AppImage",
  "Harness-1.2.3-linux-arm64.AppImage",
  "latest-mac.yml",
  "latest.yml",
  "latest-linux.yml",
  "latest-linux-arm64.yml",
];

const VALID_MANIFESTS = {
  "latest-mac.yml": `
version: 1.2.3
files:
  - url: Harness-1.2.3-mac-arm64.zip
    sha512: mac-arm64-checksum
  - url: Harness-1.2.3-mac-x64.zip
    sha512: mac-x64-checksum
`,
  "latest.yml": `
version: 1.2.3
files:
  - url: Harness-1.2.3-win-x64.exe
    sha512: win-x64-checksum
`,
  "latest-linux.yml": `
version: 1.2.3
files:
  - url: Harness-1.2.3-linux-x64.AppImage
    sha512: linux-x64-checksum
`,
  "latest-linux-arm64.yml": `
version: 1.2.3
files:
  - url: Harness-1.2.3-linux-arm64.AppImage
    sha512: linux-arm64-checksum
`,
};

const VALID_SHA512 = {
  "Harness-1.2.3-mac-arm64.zip": "mac-arm64-checksum",
  "Harness-1.2.3-mac-x64.zip": "mac-x64-checksum",
  "Harness-1.2.3-win-x64.exe": "win-x64-checksum",
  "Harness-1.2.3-linux-x64.AppImage": "linux-x64-checksum",
  "Harness-1.2.3-linux-arm64.AppImage": "linux-arm64-checksum",
};

describe("validateReleaseAssetNames", () => {
  it("accepts the complete supported update matrix", () => {
    expect(validateReleaseAssetNames(COMPLETE, "1.2.3")).toEqual([]);
  });

  it("rejects missing update artifacts and placeholder names", () => {
    const errors = validateReleaseAssetNames(
      COMPLETE.filter((name) => name !== "Harness-1.2.3-mac-x64.zip").concat(
        "REPLACE-feed.yml",
      ),
      "1.2.3",
    );

    expect(errors).toContain(
      "Missing release asset: Harness-1.2.3-mac-x64.zip",
    );
    expect(errors).toContain(
      "Release assets contain a placeholder name: REPLACE-feed.yml",
    );
  });

  it("rejects duplicate release asset names before publication", () => {
    expect(
      validateReleaseAssetNames([...COMPLETE, "latest.yml"], "1.2.3"),
    ).toContain("Duplicate release asset: latest.yml");
  });
});

describe("validateReleaseManifestContents", () => {
  it("accepts manifests whose versions, checksums, URLs, and architectures match the release", () => {
    expect(
      validateReleaseManifestContents(
        VALID_MANIFESTS,
        COMPLETE,
        "1.2.3",
        VALID_SHA512,
      ),
    ).toEqual([]);
  });

  it("rejects stale versions, missing checksums, placeholder URLs, and wrong architecture mappings", () => {
    const invalid = {
      ...VALID_MANIFESTS,
      "latest.yml": `
version: 1.2.2
files:
  - url: REPLACE-WITH-ASSET.exe
`,
      "latest-linux-arm64.yml": `
version: 1.2.3
files:
  - url: Harness-1.2.3-linux-x64.AppImage
    sha512: wrong-architecture-checksum
`,
    };

    const errors = validateReleaseManifestContents(invalid, COMPLETE, "1.2.3");

    expect(errors).toContain("latest.yml has version 1.2.2; expected 1.2.3");
    expect(errors).toContain(
      "latest.yml references a placeholder URL: REPLACE-WITH-ASSET.exe",
    );
    expect(errors).toContain(
      "latest.yml file REPLACE-WITH-ASSET.exe is missing sha512",
    );
    expect(errors).toContain(
      "latest-linux-arm64.yml does not reference Harness-1.2.3-linux-arm64.AppImage",
    );
  });

  it("rejects a checksum mismatch and unexpected architecture payload even when the expected payload exists", () => {
    const invalid = {
      ...VALID_MANIFESTS,
      "latest-linux-arm64.yml": `
version: 1.2.3
files:
  - url: Harness-1.2.3-linux-arm64.AppImage
    sha512: stale-checksum
  - url: Harness-1.2.3-linux-x64.AppImage
    sha512: linux-x64-checksum
`,
    };

    const errors = validateReleaseManifestContents(
      invalid,
      COMPLETE,
      "1.2.3",
      VALID_SHA512,
    );

    expect(errors).toContain(
      "latest-linux-arm64.yml checksum does not match Harness-1.2.3-linux-arm64.AppImage",
    );
    expect(errors).toContain(
      "latest-linux-arm64.yml references unexpected update payload Harness-1.2.3-linux-x64.AppImage",
    );
  });

  it("rejects any extra manifest payload even when it is present in the release assets", () => {
    const invalid = {
      ...VALID_MANIFESTS,
      "latest.yml": `
version: 1.2.3
files:
  - url: Harness-1.2.3-win-x64.exe
    sha512: win-x64-checksum
  - url: evil.zip
    sha512: extra-checksum
`,
    };

    const errors = validateReleaseManifestContents(
      invalid,
      [...COMPLETE, "evil.zip"],
      "1.2.3",
      { ...VALID_SHA512, "evil.zip": "extra-checksum" },
    );

    expect(errors).toContain(
      "latest.yml references unexpected update payload evil.zip",
    );
  });

  it("accepts a published companion artifact that is not itself an update payload", () => {
    // electron-builder lists the .dmg in latest-mac.yml next to the .zip it
    // actually updates from, and merge-update-manifests.js preserves every
    // entry. Rejecting it would fail every real mac release, so a companion
    // artifact that ships in the release is allowed. Only foreign payloads and
    // assets that are not release artifacts at all are rejected.
    const withDmgCompanion = {
      ...VALID_MANIFESTS,
      "latest-mac.yml": `
version: 1.2.3
files:
  - url: Harness-1.2.3-mac-arm64.zip
    sha512: mac-arm64-checksum
  - url: Harness-1.2.3-mac-x64.zip
    sha512: mac-x64-checksum
  - url: Harness-1.2.3-mac-arm64.dmg
    sha512: mac-arm64-dmg-checksum
`,
    };

    const errors = validateReleaseManifestContents(
      withDmgCompanion,
      COMPLETE,
      "1.2.3",
      VALID_SHA512,
    );

    expect(errors).toEqual([]);
  });

  it("still rejects a manifest advertising another platform's payload", () => {
    const crossPlatform = {
      ...VALID_MANIFESTS,
      "latest.yml": `
version: 1.2.3
files:
  - url: Harness-1.2.3-win-x64.exe
    sha512: win-x64-checksum
  - url: Harness-1.2.3-mac-arm64.zip
    sha512: mac-arm64-checksum
`,
    };

    const errors = validateReleaseManifestContents(
      crossPlatform,
      COMPLETE,
      "1.2.3",
      VALID_SHA512,
    );

    expect(errors).toContain(
      "latest.yml references unexpected update payload Harness-1.2.3-mac-arm64.zip",
    );
  });
});

describe("electron-builder update configuration", () => {
  const config = JSON.parse(readFileSync("electron-builder.json", "utf8")) as {
    publish: Array<{
      provider: string;
      owner?: string;
      repo?: string;
      url?: string;
    }>;
    mac: {
      target: Array<{ target: string; arch: string[] }>;
      notarize: boolean;
    };
    win: { target: Array<{ target: string; arch: string[] }> };
    linux: { target: Array<{ target: string; arch: string[] }> };
  };

  it("uses the public GitHub release feed without a placeholder URL", () => {
    expect(config.publish).toEqual([
      expect.objectContaining({
        provider: "github",
        owner: "Community-Tech-UK",
        repo: "ai-orchestrator",
      }),
    ]);
    expect(JSON.stringify(config)).not.toMatch(/REPLACE|placeholder/i);
  });

  it("builds every supported self-updating target", () => {
    expect(config.mac.target).toEqual(
      expect.arrayContaining([
        { target: "dmg", arch: ["arm64", "x64"] },
        { target: "zip", arch: ["arm64", "x64"] },
      ]),
    );
    expect(config.mac.notarize).toBe(true);
    expect(config.win.target).toContainEqual({ target: "nsis", arch: ["x64"] });
    expect(config.linux.target).toContainEqual({
      target: "AppImage",
      arch: ["x64", "arm64"],
    });
  });
});
