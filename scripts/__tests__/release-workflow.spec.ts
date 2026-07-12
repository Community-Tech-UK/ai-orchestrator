import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

interface WorkflowJob {
  permissions?: Record<string, string>;
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  steps?: Array<{ name?: string; env?: Record<string, string>; run?: string }>;
}

const workflow = load(
  readFileSync(".github/workflows/release.yml", "utf8"),
) as {
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

describe("Harness release workflow", () => {
  it("grants write permission only to the final publish job", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs["publish"]?.permissions).toEqual({
      contents: "write",
    });
    expect(workflow.jobs["preflight"]?.permissions).toBeUndefined();
    expect(workflow.jobs["build"]?.permissions).toBeUndefined();
  });

  it("uses native GitHub-hosted runners for every supported target", () => {
    const matrix = workflow.jobs["build"]?.strategy?.matrix?.include ?? [];
    expect(
      matrix.map(({ runner, arch, platform }) => ({ runner, arch, platform })),
    ).toEqual([
      { runner: "macos-15", arch: "arm64", platform: "mac" },
      { runner: "macos-15-intel", arch: "x64", platform: "mac" },
      { runner: "windows-2025", arch: "x64", platform: "win" },
      { runner: "ubuntu-24.04", arch: "x64", platform: "linux" },
      { runner: "ubuntu-24.04-arm", arch: "arm64", platform: "linux" },
    ]);
  });

  it("fails closed on signing and refuses to mutate an existing release", () => {
    const workflowText = readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflowText.match(/npm ci --legacy-peer-deps/g)).toHaveLength(3);
    expect(workflowText).toContain("--config.forceCodeSigning=true");
    expect(workflowText).toContain("codesign --verify --deep --strict");
    expect(workflowText).toContain('xcrun stapler validate "$app_path"');
    expect(workflowText).not.toContain('xcrun stapler validate "$dmg_path"');
    expect(workflowText).toContain("Get-AuthenticodeSignature");
    expect(workflowText).toContain(
      "already exists; published releases are immutable",
    );
    expect(workflowText).not.toContain("ELECTRON_MIRROR");
  });
});
