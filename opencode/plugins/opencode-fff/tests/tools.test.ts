import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  constraintGlob,
  createFffTools,
  excludeFilter,
  type FffTools,
  grepMode,
  isListingPattern,
  isWildcardOnly,
} from "../tools.ts";
import { buildQuery } from "../fff/query.ts";

let root: string;
let outside: string;
let tools: FffTools;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "opencode-fff-"));
  const ws = join(root, "workspace");
  mkdirSync(join(ws, "src/auth"), { recursive: true });
  mkdirSync(join(ws, "test"), { recursive: true });
  writeFileSync(join(ws, "src/auth/middleware.ts"), "export function authMiddleware() {\n  return checkToken();\n}\n");
  writeFileSync(join(ws, "src/server.ts"), "import { authMiddleware } from './auth/middleware';\nconst PORT = 8080;\n");
  writeFileSync(join(ws, "test/middleware.test.ts"), "authMiddleware();\n");
  writeFileSync(join(ws, "src/weird-[brackets].txt"), "see weird-[brackets] and a(b)c\n");
  writeFileSync(join(ws, "src-notes.md"), "a file outside src/ whose path still fuzzy-matches src\n");
  mkdirSync(join(ws, "many"));
  for (let i = 0; i < 120; i++) writeFileSync(join(ws, `many/item${String(i).padStart(3, "0")}.txt`), `${i}\n`);
  outside = join(root, "elsewhere");
  mkdirSync(outside);
  writeFileSync(join(outside, "notes.md"), "remember the OUTSIDE_MARKER\n");
  tools = createFffTools({
    cwd: ws,
    frecencyDbPath: join(root, "db/frecency"),
    historyDbPath: join(root, "db/history"),
  });
});

afterAll(() => {
  tools.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe("helpers", () => {
  test("regex is used only for valid patterns with metacharacters", () => {
    expect(grepMode("authMiddleware")).toBe("plain");
    expect(grepMode("export (function|const)")).toBe("regex");
    expect(grepMode("broken(")).toBe("plain");
  });

  test("wildcard-only patterns are refused", () => {
    expect(isWildcardOnly(".*")).toBe(true);
    expect(isWildcardOnly("*")).toBe(true);
    expect(isWildcardOnly("auth.*")).toBe(false);
    expect(isWildcardOnly("PORT")).toBe(false);
  });

  test("listing patterns and constraint globs", () => {
    for (const p of ["", " ", "*", "**", "**/*", ".", "./"]) expect(isListingPattern(p)).toBe(true);
    expect(isListingPattern("src")).toBe(false);
    expect(constraintGlob("src/")).toBe("src/**");
    expect(constraintGlob("**/*.ts")).toBe("**/*.ts");
    expect(constraintGlob("main.rs")).toBe("**/main.rs");
    expect(constraintGlob("src/main.rs")).toBe("src/main.rs");
  });

  test("exclude filter matches dirs, globs and names", () => {
    const keep = excludeFilter(["!test/", "!*.min.js", "!README.md"]);
    expect(keep("src/a.ts")).toBe(true);
    expect(keep("test/a.ts")).toBe(false);
    expect(keep("pkg/test/a.ts")).toBe(false);
    expect(keep("dist/app.min.js")).toBe(false);
    expect(keep("docs/README.md")).toBe(false);
  });

  test("path and exclude become FFF query constraints", () => {
    expect(buildQuery("src", "auth", "test/,*.min.js", "/ws")).toBe("src/ !test/ !*.min.js auth");
    expect(buildQuery("src/**", "x", undefined, "/ws")).toBe("src/ x");
    expect(buildQuery("main.rs", "x", "!vendor", "/ws")).toBe("main.rs !vendor/ x");
  });
});

describe("ffgrep", () => {
  test("finds content grouped by file", async () => {
    const out = await tools.grep({ pattern: "authMiddleware" });
    expect(out.text).toContain("src/auth/middleware.ts");
    expect(out.text).toMatch(/ 1: export function authMiddleware\(\) \{/);
    expect(out.metadata.totalMatched).toBeGreaterThanOrEqual(3);
  });

  test("exclude drops paths", async () => {
    const out = await tools.grep({ pattern: "authMiddleware", exclude: "test/" });
    expect(out.text).not.toContain("test/middleware.test.ts");
  });

  test("regex patterns work", async () => {
    const out = await tools.grep({ pattern: "PORT = \\d+" });
    expect(out.text).toContain("src/server.ts");
  });

  test("context lines are included", async () => {
    const out = await tools.grep({ pattern: "checkToken", context: 1 });
    expect(out.text).toContain(" 1- export function authMiddleware() {");
  });

  test("a wildcard pattern gets guidance instead of the whole repo", async () => {
    const out = await tools.grep({ pattern: ".*" });
    expect(out.text).toContain("matches everything");
  });

  test("literal: true searches exact text with regex characters", async () => {
    const out = await tools.grep({ pattern: "a(b)c", literal: true });
    expect(out.text).toContain("src/weird-[brackets].txt");
    const brackets = await tools.grep({ pattern: "weird-[brackets]", literal: true });
    expect(brackets.text).toContain("src/weird-[brackets].txt");
    expect(brackets.text.startsWith("[0 exact matches")).toBe(false);
  });

  test("a regex with no matches is retried as literal text", async () => {
    const out = await tools.grep({ pattern: "weird-[brackets]" });
    expect(out.text).toContain("src/weird-[brackets].txt");
    expect(out.text).toContain("matched as literal text");
  });

  test("a path outside the workspace is searched with its own index", async () => {
    expect(tools.externalRoot(outside)).toBe(outside);
    expect(tools.externalRoot("src/")).toBeUndefined();
    const out = await tools.grep({ pattern: "OUTSIDE_MARKER", path: outside });
    expect(out.text).toContain("notes.md");
  });
});

describe("fffind", () => {
  test("fuzzy path search matches the whole path", async () => {
    const out = await tools.find({ pattern: "auth middle" });
    expect(out.text.split("\n")[0]).toContain("src/auth/middleware.ts");
  });

  test("a glob path lists exact matches", async () => {
    const out = await tools.find({ pattern: "", path: "**/*.test.ts" });
    expect(out.text).toContain("test/middleware.test.ts");
    expect(out.text).not.toContain("src/server.ts");
  });

  test("a directory path with an empty pattern lists exactly that directory", async () => {
    for (const path of ["src/", "src/**", "src"]) {
      const out = await tools.find({ pattern: "", path });
      const files = out.text.split("\n\n")[0]!.split("\n").map((l) => l.replace(/  \[.*\]$/, ""));
      expect(files.sort()).toEqual(["src/auth/middleware.ts", "src/server.ts", "src/weird-[brackets].txt"]);
    }
  });

  test("a listing honours exclude", async () => {
    const out = await tools.find({ pattern: "*", path: "src/", exclude: "auth/" });
    expect(out.text).not.toContain("middleware.ts");
    expect(out.text).toContain("src/server.ts");
  });

  async function pageAll(first: Promise<{ text: string }>): Promise<string[]> {
    const seen: string[] = [];
    let out = await first;
    for (let guard = 0; guard < 100; guard++) {
      seen.push(...out.text.split("\n\n")[0]!.split("\n").map((l) => l.replace(/  \[.*\]$/, "")));
      const cursor = out.text.match(/cursor="([^"]+)"/)?.[1];
      if (!cursor) break;
      out = await tools.find({ pattern: "", cursor });
    }
    return seen;
  }

  test("paging through a listing returns every file exactly once", async () => {
    const seen = await pageAll(tools.find({ pattern: "", path: "many/", limit: 7 }));
    expect(seen.length).toBe(120);
    expect(new Set(seen).size).toBe(120);
  });

  test("paging through a fuzzy search keeps one stable order", async () => {
    const seen = await pageAll(tools.find({ pattern: "item", limit: 25 }));
    expect(seen.filter((p) => p.startsWith("many/item")).length).toBe(120);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("a filename with glob characters is found literally", async () => {
    const out = await tools.find({ pattern: "weird-[brackets]" });
    expect(out.text).toContain("src/weird-[brackets].txt");
  });

  test("an unknown cursor is an error", async () => {
    await expect(tools.find({ pattern: "", cursor: "nope" })).rejects.toThrow("cursor");
  });
});
