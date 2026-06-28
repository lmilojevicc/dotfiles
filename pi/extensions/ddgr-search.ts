/**
 * ddgr-search — DuckDuckGo search via the `ddgr` CLI in --json mode.
 *
 * Standalone extension. Does NOT modify pi-search-hub.
 *
 * Registers two tools:
 *   - `ddgr_search`: explicit ddgr with all ddgr-native options
 *     (region, safesearch, timeLimit, proxy).
 *   - `web_search`:  override of the bundled `web_search` tool — same ddgr
 *     backend, simpler schema. Use this when you just want the standard
 *     `web_search(query, numResults)` interface and ddgr to do the work.
 *
 * Why a separate tool: pi-search-hub's bundled `duckduckgo` backend shells out
 * to ddgs/ddgr and, when DuckDuckGo rate-limits the IP (HTTP 202), ddgr exits 0
 * with stdout `[]` — so the backend silently returns 0 results with no error.
 * This tool surfaces that as a clear, actionable error and exposes ddgr-native
 * options the bundled backend does not.
 *
 * Requires: ddgr (https://github.com/jarun/ddgr) — `brew install ddgr`.
 * ddgr --json emits an array of { title, url, abstract }.
 */

import { spawn } from "node:child_process";
import {
  type ExtensionAPI,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type, StringEnum } from "@earendil-works/pi-ai";

const TIMEOUT_MS = 30_000;

type DdgrRaw = { title?: string; url?: string; abstract?: string };
export type DdgrResult = { title: string; url: string; abstract: string };

export type DdgrOpts = {
  numResults?: number;
  region?: string;
  safesearch?: "moderate" | "off";
  timeLimit?: "d" | "w" | "m" | "y";
  proxy?: string;
};

export type DdgrOutcome =
  | { kind: "ok"; results: DdgrResult[] }
  | { kind: "rate_limited"; stderr: string }
  | { kind: "error"; message: string };

/**
 * Run `ddgr --json` with the given query and options. Resolves with a
 * discriminated outcome; throws on signal abort, timeout, and spawn failure.
 */
export function runDdgr(
  query: string,
  opts: DdgrOpts,
  signal: AbortSignal | undefined,
): Promise<DdgrOutcome> {
  const num = Math.max(1, Math.min(opts.numResults ?? 10, 25));
  const region = opts.region || "us-en";

  // --json implies --np; we pass --np explicitly for clarity. -C disables color.
  const args = ["--json", "--np", "-C", "-n", String(num), "-r", region];
  if (opts.safesearch === "off") args.push("--unsafe");
  if (opts.timeLimit) args.push("-t", opts.timeLimit);
  if (opts.proxy) args.push("-p", opts.proxy);
  args.push(query);

  return new Promise((resolve, reject) => {
    const proc = spawn("ddgr", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const onAbort = () => {
      proc.kill();
      reject(new Error("ddgr search aborted"));
    };

    if (signal) {
      if (signal.aborted) {
        proc.kill();
        reject(new Error("ddgr search aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("ddgr timed out (30s)"));
    }, TIMEOUT_MS);

    // ddgr returns exit 0 even on rate-limit (stdout `[]`, error on stderr),
    // so we always resolve from the close handler and inspect stderr ourselves.
    proc.on("close", () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);

      const stderrTrim = stderr.trim();
      const stdoutTrim = stdout.trim();

      let parsed: DdgrRaw[] = [];
      if (stdoutTrim) {
        try {
          parsed = JSON.parse(stdoutTrim) as DdgrRaw[];
        } catch {
          resolve({
            kind: "error",
            message: `ddgr returned non-JSON output. stderr: ${stderrTrim.slice(0, 300)}`,
          });
          return;
        }
      }

      if (!Array.isArray(parsed)) {
        resolve({
          kind: "error",
          message: `ddgr: expected JSON array, got: ${stdoutTrim.slice(0, 200)}`,
        });
        return;
      }

      if (parsed.length === 0) {
        if (/HTTP Error 202|ratelimit/i.test(stderrTrim)) {
          resolve({ kind: "rate_limited", stderr: stderrTrim });
          return;
        }
        if (stderrTrim && /error/i.test(stderrTrim)) {
          resolve({
            kind: "error",
            message: `ddgr returned no results. ddgr reported: ${stderrTrim.slice(0, 300)}`,
          });
          return;
        }
        // Genuine zero results.
        resolve({ kind: "ok", results: [] });
        return;
      }

      const cleaned: DdgrResult[] = [];
      for (const r of parsed) {
        if (r.url && r.title) {
          cleaned.push({ title: r.title, url: r.url, abstract: r.abstract || "" });
        }
      }
      resolve({ kind: "ok", results: cleaned });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(new Error(`ddgr spawn error: ${err.message}`));
    });
  });
}

type StatusCtx = {
  ui: { setStatus: (key: string, value: string) => void };
};
type OnUpdate = (update: { content: Array<{ type: "text"; text: string }> }) => void;
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

function makeSetStatus(ctx: StatusCtx, onUpdate?: OnUpdate): (s: string) => void {
  return (s: string) => {
    ctx.ui.setStatus("ddgr", s);
    onUpdate?.({ content: [{ type: "text", text: `*${s}*` }] });
  };
}

function formatDdgr(
  query: string,
  outcome: DdgrOutcome,
  ctx: StatusCtx,
  onUpdate?: OnUpdate,
): ToolResult {
  const setStatus = makeSetStatus(ctx, onUpdate);

  if (outcome.kind === "error") {
    setStatus(`❌ ddgr: ${outcome.message.slice(0, 60)}`);
    throw new Error(outcome.message);
  }

  if (outcome.kind === "rate_limited") {
    setStatus("❌ ddgr: DuckDuckGo rate-limited (HTTP 202)");
    throw new Error(
      "DuckDuckGo rate-limited this IP (HTTP 202). ddgr cannot fetch results right now. " +
        "Retry later, pass a `proxy`, or fall back to the searxng backend.",
    );
  }

  // outcome.kind === "ok"
  if (outcome.results.length === 0) {
    setStatus("🔍 ddgr: 0 results");
    return {
      content: [{ type: "text", text: `No results for: ${query}` }],
      details: { backend: "ddgr", resultCount: 0, query, rateLimited: false },
    };
  }

  setStatus(`🔍 ddgr: ${outcome.results.length} results`);

  const body = outcome.results
    .map(
      (r, i) =>
        `### ${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.abstract}`.trimEnd(),
    )
    .join("\n\n");

  const head = `## ddgr results: ${query}\n\n`;
  const trunc = truncateHead(head + body, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  let text = trunc.content;
  if (trunc.truncated) {
    text +=
      `\n\n[Output truncated: ${trunc.outputLines}/${trunc.totalLines} lines, ` +
      `${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)}]`;
  }

  return {
    content: [{ type: "text", text }],
    details: {
      backend: "ddgr",
      resultCount: outcome.results.length,
      query,
      rateLimited: false,
    },
  };
}

export default function ddgrSearch(pi: ExtensionAPI): void {
  // Tool A: explicit ddgr with all ddgr-native options.
  pi.registerTool({
    name: "ddgr_search",
    label: "ddgr Search",
    description:
      "Search DuckDuckGo via the `ddgr` CLI in JSON mode. Free, no API key. " +
      "Use when web_search's DuckDuckGo backend returns nothing (rate-limited) or " +
      "when you need ddgr-native options (region, safesearch, timeLimit, proxy). " +
      "Returns a clear error on DuckDuckGo rate-limit instead of silent empties. " +
      "Requires ddgr installed (`brew install ddgr`).",
    promptSnippet: "Search DuckDuckGo via ddgr CLI (JSON mode)",
    promptGuidelines: [
      "Use ddgr_search for DuckDuckGo results via the ddgr CLI; it reports rate-limits as errors instead of silent empties.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Search query (natural language works best)",
      }),
      numResults: Type.Optional(
        Type.Number({
          description: "Number of results (1-25, default 10)",
          default: 10,
        }),
      ),
      region: Type.Optional(
        Type.String({
          description:
            "Region, e.g. 'us-en' (default), 'uk-en'. See https://duckduckgo.com/params",
          default: "us-en",
        }),
      ),
      safesearch: Type.Optional(
        StringEnum(["moderate", "off"] as const, {
          description:
            "Safe-search level. ddgr only supports 'off' (via --unsafe); 'moderate' is the default behavior.",
        }),
      ),
      timeLimit: Type.Optional(
        StringEnum(["d", "w", "m", "y"] as const, {
          description: "Restrict to a time span: d (day), w (week), m (month), y (year)",
        }),
      ),
      proxy: Type.Optional(
        Type.String({
          description:
            "Optional HTTPS proxy URI (ddgr -p). Format: https://user:pass@host:port — routes requests through the proxy to bypass DuckDuckGo IP rate-limits.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const setStatus = makeSetStatus(ctx, onUpdate);
      setStatus("🔍 ddgr: searching...");
      const outcome = await runDdgr(
        params.query,
        {
          numResults: params.numResults,
          region: params.region,
          safesearch: params.safesearch,
          timeLimit: params.timeLimit,
          proxy: params.proxy,
        },
        signal,
      );
      return formatDdgr(params.query, outcome, ctx, onUpdate);
    },
  });

  // NOTE: `web_search` override removed (see project notes). The bundled
  // pi-search-hub `web_search` is currently active. Use `ddgr_search` for
  // explicit ddgr-backed search. The shared `runDdgr` core remains available
  // for a future re-introduction via a non-conflicting approach.
}
