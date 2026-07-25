import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
}

interface WorkflowJob {
  needs?: string | string[];
  permissions?: Record<string, string>;
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  steps?: WorkflowStep[];
}

const workflow = load(
  readFileSync(".github/workflows/release.yml", "utf8"),
) as {
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};
const ciWorkflow = load(
  readFileSync(".github/workflows/ci.yml", "utf8"),
) as {
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};
const workflowSources = [
  readFileSync(".github/workflows/ci.yml", "utf8"),
  readFileSync(".github/workflows/release.yml", "utf8"),
];
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

function allActionRefs(): string[] {
  return [ciWorkflow, workflow].flatMap(({ jobs }) =>
    Object.values(jobs).flatMap((job) =>
      (job.steps ?? [])
        .map((step) => step.uses)
        .filter((uses): uses is string => typeof uses === "string"),
    ),
  );
}

function stepIndex(job: WorkflowJob | undefined, name: string): number {
  return job?.steps?.findIndex((step) => step.name === name) ?? -1;
}

describe("Harness release workflow", () => {
  it("grants write permission only to the final publish job", () => {
    expect(workflow.permissions).toEqual({
      actions: "read",
      contents: "read",
    });
    expect(workflow.jobs["publish"]?.permissions).toEqual({
      contents: "write",
    });
    expect(workflow.jobs["preflight"]?.permissions).toBeUndefined();
    expect(workflow.jobs["build"]?.permissions).toBeUndefined();
  });

  it("pins every external action to a reviewed commit", () => {
    const actionRefs = allActionRefs();
    const actionLines = workflowSources.flatMap((source) =>
      source.split("\n").filter((line) => /^\s+(?:- )?uses:/u.test(line)),
    );

    expect(actionRefs.length).toBeGreaterThan(0);
    for (const actionRef of actionRefs) {
      expect(actionRef).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
    }
    expect(actionLines).toHaveLength(actionRefs.length);
    for (const actionLine of actionLines) {
      expect(actionLine).toMatch(
        /^\s+(?:- )?uses: [^@\s]+@[0-9a-f]{40} # v[^\s]+$/u,
      );
    }
  });

  it("audits production dependencies early and reports external catalog drift as a warning", () => {
    const securitySteps = ciWorkflow.jobs["security"]?.steps ?? [];
    const qualitySteps = ciWorkflow.jobs["quality"]?.steps ?? [];
    const modelCatalogStep = qualitySteps.find(
      (step) => step.name === "Check model-catalog snapshot drift",
    );

    expect(securitySteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Audit production dependencies",
          run: "npm run audit:production",
        }),
        expect.objectContaining({
          name: "Audit build dependencies for critical findings",
          run: "npm run audit:build",
        }),
      ]),
    );
    expect(
      qualitySteps.some((step) => step.name === "Security audit"),
    ).toBe(false);
    expect(ciWorkflow.jobs["macos-smoke"]?.needs).toEqual([
      "quality",
      "security",
      "test",
    ]);
    expect(modelCatalogStep?.run).toContain("::warning");
    expect(modelCatalogStep?.["continue-on-error"]).toBeUndefined();
  });

  it("rejects critical build findings and requires a patched AppImage builder", () => {
    expect(packageJson.scripts["audit:build"]).toBe(
      "node scripts/audit-build-dependencies.js && node scripts/verify-release-toolchain.js",
    );
    expect(packageJson.devDependencies["electron-builder"]).toMatch(
      /^\^26\.(?:1[5-9]|[2-9]\d)\.\d+$/u,
    );
  });

  it("fails release admission before installation or matrix builds", () => {
    const preflight = workflow.jobs["preflight"];
    const names = [
      "Refuse an existing GitHub Release",
      "Require the tagged commit on main",
      "Require successful CI for the tagged commit",
      "Validate release tag",
      "Audit production dependencies",
      "Audit build dependencies for critical findings",
      "Install dependencies",
    ];
    const indices = names.map((name) => stepIndex(preflight, name));
    const steps = preflight?.steps ?? [];

    expect(indices.every((index) => index >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((left, right) => left - right));
    expect(steps[indices[0]]?.run).toContain("gh release view");
    expect(steps[indices[1]]?.run).toContain("git merge-base --is-ancestor");
    expect(steps[indices[2]]?.run).toContain(
      "actions/workflows/ci.yml/runs",
    );
    expect(steps[indices[2]]?.run).toContain('.event == "push"');
    expect(steps[indices[2]]?.run).toContain('.head_branch == "main"');
    expect(steps[indices[3]]?.run).toContain("release:validate-tag");
    expect(steps[indices[4]]?.run).toBe("npm run audit:production");
    expect(steps[indices[5]]?.run).toBe("npm run audit:build");
    expect(steps[indices[6]]?.run).toBe("npm ci");
    expect(JSON.stringify(preflight)).not.toContain("immutable-releases");
    expect(JSON.stringify(preflight)).not.toContain("${{ secrets.");
    expect(workflow.jobs["build"]?.needs).toBe("preflight");
  });

  it("uses strict installs and refuses to overwrite release assets", () => {
    const installSteps = Object.values(workflow.jobs).flatMap((job) =>
      (job.steps ?? []).filter((step) => step.run?.startsWith("npm ci")),
    );
    const publishStep = workflow.jobs["publish"]?.steps?.find(
      (step) => step.name === "Publish stable release",
    );

    expect(installSteps).toHaveLength(3);
    expect(installSteps.every((step) => step.run === "npm ci")).toBe(true);
    expect(JSON.stringify(workflow)).not.toContain("legacy-peer-deps");
    expect(publishStep?.with).toEqual(
      expect.objectContaining({
        fail_on_unmatched_files: true,
        overwrite_files: false,
      }),
    );
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
    expect(workflowText).toContain("--config.forceCodeSigning=true");
    expect(workflowText).toContain("codesign --verify --deep --strict");
    expect(workflowText).toContain(
      'node scripts/verify-macos-helper-identity.js "$app_path"',
    );
    expect(workflowText).toContain('xcrun stapler validate "$app_path"');
    expect(workflowText).not.toContain('xcrun stapler validate "$dmg_path"');
    expect(workflowText).toContain("Get-AuthenticodeSignature");
    expect(workflowText).toContain(
      "already exists; release policy forbids mutation",
    );
    expect(workflowText).not.toContain("ELECTRON_MIRROR");
  });

  it("launches every unpacked package before collecting publishable assets", () => {
    const steps = workflow.jobs["build"]?.steps ?? [];
    const packageIndex = steps.findIndex((step) => step.name === "Package signed update artifacts");
    const smokeIndex = steps.findIndex((step) => step.name === "Launch packaged app smoke");
    const collectIndex = steps.findIndex((step) => step.name === "Collect release assets");

    expect(smokeIndex).toBeGreaterThan(packageIndex);
    expect(smokeIndex).toBeLessThan(collectIndex);
    expect(steps[smokeIndex]?.run).toBe("node scripts/packaged-startup-smoke.js");
  });

  it("launches the unpacked macOS package in CI", () => {
    const steps = ciWorkflow.jobs["macos-smoke"]?.steps ?? [];
    const buildIndex = steps.findIndex((step) => step.name === "Build application");
    const packageIndex = steps.findIndex(
      (step) => step.name === "Electron packaging smoke (--dir, no signing)",
    );
    const smokeIndex = steps.findIndex((step) => step.name === "Launch packaged app smoke");

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(steps[buildIndex]?.run).toBe("npm run build");
    expect(steps[buildIndex]?.env).toEqual({
      NODE_OPTIONS: "--max-old-space-size=5120",
      NG_BUILD_PARALLEL_TS: "false",
      NG_BUILD_MAX_WORKERS: "2",
    });
    expect(packageIndex).toBeGreaterThan(buildIndex);
    expect(smokeIndex).toBeGreaterThan(packageIndex);
    expect(steps[smokeIndex]?.run).toBe("node scripts/packaged-startup-smoke.js");
  });
});
