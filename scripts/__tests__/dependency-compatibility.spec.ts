import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface LockEntry {
  version?: string;
  dev?: boolean;
  optional?: boolean;
  peer?: boolean;
  devOptional?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PackageLock {
  packages: Record<string, LockEntry>;
}

/** `<kind>: <name>@<version> <absolute path>` */
const TREE_PROBLEM = /^(\w+):\s+(@?[^@\s]+(?:\/[^@\s]+)?)@(\S+)\s+(.+)$/;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function toLockPath(absolutePath: string): string {
  return path.relative(process.cwd(), absolutePath).split(path.sep).join("/");
}

/**
 * Where npm would resolve `name` from `requirerPath`: the nearest enclosing
 * `node_modules/<name>`, walking up the nesting chain, then the root copy.
 */
function resolutionPathFor(
  requirerPath: string,
  name: string,
  lock: PackageLock,
): string | undefined {
  let prefix = requirerPath;
  for (;;) {
    const candidate = `${prefix}/node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    const nested = prefix.lastIndexOf("/node_modules/");
    if (nested < 0) break;
    prefix = prefix.slice(0, nested);
  }
  const root = `node_modules/${name}`;
  return lock.packages[root] ? root : undefined;
}

/**
 * `npm ls` exits non-zero for two conditions that cannot break the shipped app,
 * so its exit code is not a usable proxy for "the production tree is valid":
 *
 *  - `extraneous` for a package installed ONLY to satisfy an optional peer edge.
 *    `@angular-devkit/build-angular` declares an optional peer on vitest, so npm
 *    installs a nested vitest and hoists its `obug` dependency to the root. With
 *    no required edge npm calls them extraneous, but extra files on disk cannot
 *    break a runtime, and the lock marks them `dev + optional + peer`.
 *  - `invalid` where the installed version in fact satisfies every range the lock
 *    records against that copy. npm reports `@types/node@22.19.15` invalid
 *    against `"*"` from `@types/ws`, which semver plainly satisfies.
 *
 * Everything else still fails — above all `missing`, the one that really does
 * break a runtime. Unparseable or unclassifiable problems fail CLOSED, so this
 * cannot quietly become a filter that swallows real breakage.
 */
function isBenignTreeProblem(problem: string, lock: PackageLock): boolean {
  const match = TREE_PROBLEM.exec(problem.trim());
  if (!match) return false;

  const [, kind, name, version, absolutePath] = match;
  const lockPath = toLockPath(absolutePath ?? "");
  const entry = lock.packages[lockPath];
  if (!entry) return false;

  if (kind === "extraneous") {
    return Boolean(entry.dev || entry.devOptional) && Boolean(entry.optional || entry.peer);
  }

  if (kind === "invalid") {
    return everyRecordedRangeIsSatisfied(lockPath, name ?? "", version ?? "", lock);
  }

  return false;
}

/** True when every lock edge that resolves to `lockPath` accepts its version. */
function everyRecordedRangeIsSatisfied(
  lockPath: string,
  name: string,
  version: string,
  lock: PackageLock,
): boolean {
  const semver = require("semver") as {
    satisfies(version: string, range: string): boolean;
    validRange(range: string): string | null;
  };

  for (const [requirerPath, requirer] of Object.entries(lock.packages)) {
    for (const field of DEPENDENCY_FIELDS) {
      const range = requirer[field]?.[name];
      if (range === undefined) continue;
      if (resolutionPathFor(requirerPath, name, lock) !== lockPath) continue;
      // A non-semver range (git url, `workspace:`, alias) is not something this
      // check can adjudicate — treat it as unexplained rather than benign.
      if (!semver.validRange(range)) return false;
      if (!semver.satisfies(version, range)) return false;
    }
  }

  return true;
}

interface ArchiveStream {
  append(source: string, data: { name: string }): ArchiveStream;
  finalize(): Promise<void>;
  on(event: "data", listener: (chunk: Buffer) => void): ArchiveStream;
}

const require = createRequire(import.meta.url);

describe("dependency compatibility", () => {
  it("keeps the installed production tree valid", () => {
    const result = spawnSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });

    // npm exits 1 on ELSPROBLEMS but still writes the full report to stdout.
    expect(result.stdout, result.stderr).toBeTruthy();
    const report = JSON.parse(result.stdout) as { problems?: string[] };
    const lock = JSON.parse(
      readFileSync("package-lock.json", "utf8"),
    ) as PackageLock;

    const unexplained = (report.problems ?? []).filter(
      (problem) => !isBenignTreeProblem(problem, lock),
    );

    expect(unexplained, unexplained.join("\n")).toEqual([]);
  });

  it("still fails on tree problems that could break a runtime", () => {
    // Locks the classifier's fail-closed contract. Without this, loosening the
    // production-tree check above to tolerate optional-peer noise could rot into
    // a filter that explains away a genuinely broken install.
    const lock = JSON.parse(
      readFileSync("package-lock.json", "utf8"),
    ) as PackageLock;
    const root = process.cwd();

    const mustFail = [
      // The one that really breaks a runtime.
      `missing: zod@4.3.6 ${root}/node_modules/zod`,
      // Extraneous, but for a required production package rather than an
      // unfulfilled optional peer.
      `extraneous: zod@4.3.6 ${root}/node_modules/zod`,
      // Invalid with a version that genuinely fails the recorded ranges.
      `invalid: @types/node@1.0.0 ${root}/node_modules/@types/node`,
      // Not attributable to any installed package.
      `extraneous: not-a-real-package@1.0.0 ${root}/node_modules/not-a-real-package`,
      "unparseable npm output",
    ];

    for (const problem of mustFail) {
      expect(isBenignTreeProblem(problem, lock), problem).toBe(false);
    }
  });

  it("expands brace patterns through every installed minimatch copy", () => {
    const lock = JSON.parse(
      readFileSync("package-lock.json", "utf8"),
    ) as PackageLock;
    const minimatchPaths = Object.entries(lock.packages)
      .filter(([packagePath]) => packagePath.endsWith("node_modules/minimatch"))
      .map(([packagePath, entry]) => ({
        packagePath,
        version: entry.version ?? "unknown",
      }));

    expect(minimatchPaths.length).toBeGreaterThan(0);
    for (const { packagePath, version } of minimatchPaths) {
      const imported = require(path.resolve(packagePath)) as
        | ((candidate: string, pattern: string) => boolean)
        | {
            default?: (candidate: string, pattern: string) => boolean;
            minimatch?: (candidate: string, pattern: string) => boolean;
          };
      const minimatch =
        typeof imported === "function"
          ? imported
          : (imported.minimatch ?? imported.default);

      expect(minimatch, `${packagePath}@${version}`).toBeTypeOf("function");
      expect(
        minimatch?.("Harness-linux-x64.zip", "Harness-{linux,mac}-*.zip"),
        `${packagePath}@${version}`,
      ).toBe(true);
    }
  });

  it("keeps WhatsApp's optional archive API compatible", async () => {
    const archiver = require("archiver") as (
      format: "zip",
    ) => ArchiveStream;
    const archive = archiver("zip");
    const chunks: Buffer[] = [];

    archive.on("data", (chunk) => chunks.push(chunk));
    archive.append("session", { name: "session.txt" });
    await archive.finalize();

    expect(Buffer.concat(chunks).subarray(0, 2).toString("ascii")).toBe("PK");
  });
});
