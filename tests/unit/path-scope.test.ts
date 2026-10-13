import { describe, expect, it } from "vitest";

import { globToRegExp, isPathAllowedInScope, matchPathByPattern } from "../../src/shared/core/paths.js";

describe("shared core path glob helpers", () => {
  it.each([
    ["src/main/index.ts", "src/main/index.ts", true],
    ["src/main/index.ts", "src/main/*", true],
    ["src/main\\index.ts", "src/main/*", true],
    ["src/main/a/b", "src/main/**", true],
    ["src/main/a/b/c.ts", "src/main/**/c.ts", true],
    ["src/main/a/b", "src/main/*.ts", false],
    ["src/main/a/b", "src/**/main", false],
    ["src/main/a", "/src/main/**", false],
    ["src/main/a", "C:**", false]
  ])("matchPathByPattern(%s, %s) => %s", (candidate, pattern, expected) => {
    expect(matchPathByPattern(candidate, pattern)).toBe(expected);
  });

  it("rejects dangerous path candidates", () => {
    expect(matchPathByPattern("../outside", "src/**")).toBe(false);
    expect(matchPathByPattern("safe/../../bad", "safe/**")).toBe(false);
    expect(matchPathByPattern("C:relative/path", "C:relative/*")).toBe(false);
  });

  it("supports wildcard and segment boundary in scope matching", () => {
    const result = isPathAllowedInScope("src/renderer/features/projects/view.tsx", {
      allowed_paths: ["src/renderer/**"],
      forbidden_paths: ["src/renderer/private/**"]
    });
    expect(result.match).toBe(true);
    const blocked = isPathAllowedInScope("src/renderer/private/secrets.ts", {
      allowed_paths: ["src/renderer/**"],
      forbidden_paths: ["src/renderer/private/**"]
    });
    expect(blocked.match).toBe(false);
  });

  it("creates regex that supports escaped chars", () => {
    const re = globToRegExp("src/main/file?.tsx");
    expect(re.test("src/main/file1.tsx")).toBe(true);
    expect(re.test("src/main/fileaa.tsx")).toBe(false);
  });
});
