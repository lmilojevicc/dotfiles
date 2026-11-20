/**
 * opencode-fff — FFF-powered file and content search for OpenCode (v2), as native tools.
 *
 * The OpenCode counterpart of @ff-labs/pi-fff: `fffind` (fuzzy path / glob search) and `ffgrep`
 * (content search), both frecency-ranked and git-aware, backed by one in-process FFF index of the
 * workspace instead of a subprocess per call. pi-fff's multi-pattern grep is left out.
 *
 * The tools sit next to OpenCode's built-in `grep` and `glob` and ask the same permissions: `grep`
 * and `glob` on the pattern, plus `external_directory` for a path outside the workspace.
 *
 * Options (`plugins[].options`): enableHomeDirScanning (default true),
 * enableFsRootScanning (default false), followSymlinks (default true), frecencyDb, historyDb.
 */
import { createFffTools, DEFAULT_FIND_LIMIT, DEFAULT_GREP_LIMIT, GREP_CONTEXT_MAX, type ToolOutput } from "./tools.ts";

export interface Options {
  enabled?: boolean;
  enableHomeDirScanning?: boolean;
  enableFsRootScanning?: boolean;
  followSymlinks?: boolean;
  frecencyDb?: string;
  historyDb?: string;
}

const pathOrGlob =
  "Path constraint: directory prefix (src/), filename with extension (main.rs) or glob (*.ts, src/**/*.cc, {src,lib}/**), matched against the repo-relative path. Absolute, ~/ and ../ paths outside the workspace are searched with a separate index.";
const excludeDescription =
  "Paths to exclude (comma/space-separated or array), same syntax as path. A leading '!' is optional: 'test/,*.min.js,!vendor/'.";
const excludeSchema = {
  anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  description: excludeDescription,
};

export const GREP_TOOL = "ffgrep";
export const FIND_TOOL = "fffind";

interface Invocation {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
}

export default {
  id: "opencode-fff",
  async setup(ctx: any) {
    const options = (ctx?.options ?? {}) as Options;
    if (options.enabled === false) return;

    const tools = createFffTools({
      cwd: ctx.location.directory,
      frecencyDbPath: options.frecencyDb,
      historyDbPath: options.historyDb,
      enableHomeDirScanning: options.enableHomeDirScanning,
      enableFsRootScanning: options.enableFsRootScanning,
      followSymlinks: options.followSymlinks,
      onWarning: (message) => console.warn(`[opencode-fff] ${message}`),
    });

    /** The same checks OpenCode's own grep/glob make, so permission rules apply to these tools too. */
    async function authorize(action: string, call: Invocation, pattern: string, path: string | undefined, metadata: object) {
      const source = { type: "tool", messageID: call.messageID, id: call.id };
      const external = tools.externalRoot(path);
      if (external) {
        const resource = `${external.replace(/\/+$/, "")}/*`;
        await ctx.permission.assert({
          sessionID: call.sessionID,
          agent: call.agent,
          action: "external_directory",
          resources: [resource],
          save: [resource],
          source,
        });
      }
      await ctx.permission.assert({
        sessionID: call.sessionID,
        agent: call.agent,
        action,
        resources: [pattern],
        save: ["*"],
        metadata: { root: ".", path, ...metadata },
        source,
      });
    }

    const result = (output: ToolOutput) => ({ content: output.text, metadata: output.metadata });

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: GREP_TOOL,
        options: { codemode: false },
        description: [
          `Grep file contents with FFF. Smart-case, auto-detects regex vs literal, git-aware. Results are ranked by frecency (most-accessed files first); matches within a file stay in source order. Default limit ${DEFAULT_GREP_LIMIT}.`,
          "Prefer bare identifiers as patterns; literal queries are most efficient.",
          "Use path to include ('src/', '*.ts') and exclude to cut noise ('test/,*.min.js').",
          "Set caseSensitive: true for exact case (smart-case otherwise).",
          "Set literal: true to search exact text that contains regex characters.",
          "After 1-2 greps, read the top match instead of grepping again.",
        ].join("\n"),
        input: {
          type: "object",
          properties: {
            pattern: { type: "string", minLength: 1, description: "Search pattern (literal text or regex)" },
            path: { type: "string", description: pathOrGlob },
            exclude: excludeSchema,
            caseSensitive: {
              type: "boolean",
              description: "Force case-sensitive matching. Default is smart-case (case-insensitive when the pattern is all lowercase).",
            },
            literal: {
              type: "boolean",
              description: "Treat the pattern as exact text, not a regex (for code with ( ) [ ] . * etc.). No fuzzy fallback.",
            },
            context: { type: "number", description: `Context lines before and after each match (0-${GREP_CONTEXT_MAX})` },
            limit: { type: "number", description: `Max matches (default ${DEFAULT_GREP_LIMIT})` },
            cursor: { type: "string", description: "Pagination cursor from a previous result" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
        execute: async (input: any, call: Invocation) => {
          await authorize("grep", call, input.pattern, input.path, {
            exclude: input.exclude,
            caseSensitive: input.caseSensitive,
            literal: input.literal,
            limit: input.limit,
          });
          return result(await tools.grep(input));
        },
      });

      editor.add({
        name: FIND_TOOL,
        options: { codemode: false },
        description: [
          `Fuzzy path search and glob search with FFF. Matches the whole repo-relative path, not just the filename. Frecency-ranked, git-aware. Multiple words narrow the search (AND). Default limit ${DEFAULT_FIND_LIMIT}.`,
          "Keep queries to 1-2 terms; use it for paths, not content (use ffgrep for content).",
          "For an exact filename use a glob in path, e.g. path: '**/profile.h' or 'src/**/profile.h'; bare patterns are fuzzy.",
          "To list a directory, pass path: 'dir/**' with an empty or wildcard pattern.",
          "Use exclude: 'test/,*.min.js' to cut noise in large repos.",
        ].join("\n"),
        input: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Fuzzy query matched against the whole path, e.g. 'auth middleware'" },
            path: { type: "string", description: pathOrGlob },
            exclude: excludeSchema,
            limit: { type: "number", description: `Max results per page (default ${DEFAULT_FIND_LIMIT})` },
            cursor: { type: "string", description: "Pagination cursor from a previous result" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
        execute: async (input: any, call: Invocation) => {
          await authorize("glob", call, input.pattern || input.path || "*", input.path, {
            exclude: input.exclude,
            limit: input.limit,
          });
          return result(await tools.find(input));
        },
      });

    });

    // Index in the background so the first search does not wait for the scan.
    tools.warm();
    return () => tools.dispose();
  },
};
