/** The OpenCode wiring: tool registration, permission checks, options. Uses a fake plugin context. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { FIND_TOOL, GREP_TOOL } from "../index.ts";

let root: string;
const cleanups: Array<() => void> = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "opencode-fff-plugin-"));
  mkdirSync(join(root, "ws/src"), { recursive: true });
  writeFileSync(join(root, "ws/src/app.ts"), "export const answer = 42;\n");
  mkdirSync(join(root, "other"));
  writeFileSync(join(root, "other/x.txt"), "needle\n");
});

afterAll(() => {
  for (const cleanup of cleanups) cleanup();
  rmSync(root, { recursive: true, force: true });
});

async function load(options: Record<string, unknown> = {}, deny?: string) {
  const tools = new Map<string, any>();
  const asserts: any[] = [];
  const ctx = {
    options: { frecencyDb: join(root, "db/f"), historyDb: join(root, "db/h"), ...options },
    location: { directory: join(root, "ws") },
    permission: {
      assert: async (input: any) => {
        asserts.push(input);
        if (input.action === deny) throw new Error(`denied: ${deny}`);
      },
    },
    tool: {
      transform: async (fn: (editor: any) => void) => fn({ add: (tool: any) => tools.set(tool.name, tool) }),
    },
  };
  const cleanup = await plugin.setup(ctx);
  if (typeof cleanup === "function") cleanups.push(cleanup);
  return { tools, asserts };
}

const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" };

test("registers ffgrep and fffind as native tools", async () => {
  const { tools } = await load();
  expect([...tools.keys()].sort()).toEqual([FIND_TOOL, GREP_TOOL].sort());
  for (const tool of tools.values()) {
    expect(tool.options).toEqual({ codemode: false });
    expect(tool.input.type).toBe("object");
  }
});

test("disabled registers nothing", async () => {
  const { tools } = await load({ enabled: false });
  expect(tools.size).toBe(0);
});

test("ffgrep asks the grep permission, like the built-in grep, then searches", async () => {
  const { tools, asserts } = await load();
  const out = await tools.get(GREP_TOOL).execute({ pattern: "answer" }, call);
  expect(asserts).toHaveLength(1);
  expect(asserts[0]).toMatchObject({
    action: "grep",
    resources: ["answer"],
    sessionID: "ses_1",
    agent: "build",
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  });
  expect(out.content).toContain("src/app.ts");
});

test("fffind asks the glob permission", async () => {
  const { tools, asserts } = await load();
  const out = await tools.get(FIND_TOOL).execute({ pattern: "app" }, call);
  expect(asserts[0].action).toBe("glob");
  expect(out.content).toContain("src/app.ts");
});

test("a path outside the workspace also needs external_directory", async () => {
  const { tools, asserts } = await load();
  const other = join(root, "other");
  const out = await tools.get(GREP_TOOL).execute({ pattern: "needle", path: other }, call);
  expect(asserts.map((a) => a.action)).toEqual(["external_directory", "grep"]);
  expect(asserts[0].resources).toEqual([`${other}/*`]);
  expect(out.content).toContain("x.txt");
});

test("a denied permission stops the search", async () => {
  const { tools } = await load({}, "grep");
  await expect(tools.get(GREP_TOOL).execute({ pattern: "answer" }, call)).rejects.toThrow("denied: grep");
});
