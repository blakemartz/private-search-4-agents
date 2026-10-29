// The package root (the directory holding this project's package.json),
// found by walking up from this module rather than by a fixed number of `..`
// segments. A fixed path breaks whenever a module moves between directories or
// runs from a different layout: tests execute TS from src/, node runs the
// compiled build/src/, and the container copies build/ under /app.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "private-search-4-agents";

export interface PackageInfo {
  root: string | null;
  version: string;
}

function findPackage(): PackageInfo {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as { name?: string; version?: string };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === "string") {
        return { root: dir, version: pkg.version };
      }
    } catch {
      // no package.json here (or unreadable) — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: null, version: "0.0.0" };
}

export const PACKAGE = findPackage();
