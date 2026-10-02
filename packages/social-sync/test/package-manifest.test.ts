import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const exportsMap = manifest.exports as Record<string, { "post-sync-source": string; types: string; default: string }>;

describe("package.json", () => {
  it("points main/types at the root export, for TypeScript's node10 resolution (module commonjs)", () => {
    expect(manifest.main).toBe(exportsMap["."].default);
    expect(manifest.types).toBe(exportsMap["."].types);
  });

  it("maps every subpath export in typesVersions to the same declarations", () => {
    const subpaths = Object.keys(exportsMap).filter((key) => key !== ".");
    const mapped = manifest.typesVersions["*"] as Record<string, string[]>;
    expect(Object.keys(mapped).sort()).toEqual(subpaths.map((s) => s.slice(2)).sort());
    for (const subpath of subpaths) expect(mapped[subpath.slice(2)], subpath).toEqual([exportsMap[subpath].types]);
  });

  it("builds each export from a source file that exists", () => {
    for (const [subpath, entry] of Object.entries(exportsMap)) {
      const source = entry["post-sync-source"];
      expect(fs.existsSync(path.join(root, source)), subpath).toBe(true);
      const built = source.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "");
      expect(entry.default, subpath).toBe(`${built}.js`);
      expect(entry.types, subpath).toBe(`${built}.d.ts`);
    }
  });
});
