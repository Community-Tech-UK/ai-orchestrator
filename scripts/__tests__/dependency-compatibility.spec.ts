import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface PackageLock {
  packages: Record<string, { version?: string }>;
}

interface ArchiveStream {
  append(source: string, data: { name: string }): ArchiveStream;
  finalize(): Promise<void>;
  on(event: "data", listener: (chunk: Buffer) => void): ArchiveStream;
}

const require = createRequire(import.meta.url);

describe("dependency compatibility", () => {
  it("keeps the installed production tree valid", () => {
    const result = spawnSync("npm", ["ls", "--omit=dev", "--all"], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
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
