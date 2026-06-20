/**
 * GLM Coding Plan Usage extension for pi
 *
 * Registers /glm-usage which queries the Zhipu/Z.ai quota endpoint and
 * displays a formatted summary. Also shows usage % in the footer on startup.
 * Requires GLM_API_KEY in the environment.
 *
 * Reload after edits with: /reload
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const STATUS_KEY = "glm-usage";

interface QuotaLimit {
  type: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: string;
  usageDetails?: Array<{ modelCode: string; usage: number }>;
}

interface QuotaResponse {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: { level?: string; limits?: QuotaLimit[] };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Usage percentage for a quota limit window; 0 if the limit is absent. */
function pctOf(limit: QuotaLimit | undefined): number {
  if (!limit) return 0;
  if (typeof limit.percentage === "number") return limit.percentage;
  const total = limit.usage ?? 0;
  const used = limit.currentValue ?? 0;
  return total ? (used / total) * 100 : 0;
}

function setStatus(ctx: ExtensionContext, text?: string) {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.setStatus(STATUS_KEY, text);
  } catch {
    // UI context can become stale during reload/shutdown.
  }
}

async function fetchQuota(apiKey: string): Promise<QuotaResponse> {
  const res = await fetch(QUOTA_URL, {
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      "Accept-Language": "en-US,en",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GLM API returned ${res.status}`);
  return (await res.json()) as QuotaResponse;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const apiKey = process.env.GLM_API_KEY;
    if (!apiKey) {
      setStatus(ctx, "GLM: no key");
      return;
    }
    try {
      const payload = await fetchQuota(apiKey);
      const data = payload.data;
      if (!data?.limits?.length) {
        setStatus(ctx, "GLM: error");
        return;
      }
      // GLM returns multiple TOKENS_LIMIT windows distinguished by unit/number:
      //   weekly = { unit: 6, number: 1 }  (~7-day reset)
      //   5-hour = { unit: 3, number: 5 }  (sub-hour reset)
      const weeklyLimit = data.limits.find(
        (l) => l.type === "TOKENS_LIMIT" && l.unit === 6 && l.number === 1,
      );
      const fiveHourLimit = data.limits.find(
        (l) => l.type === "TOKENS_LIMIT" && l.unit === 3 && l.number === 5,
      );
      const weekPct = pctOf(weeklyLimit);
      const fiveHourPct = pctOf(fiveHourLimit);
      const level = data.level ? data.level.toUpperCase() : "GLM";
      setStatus(ctx, `GLM ${level} W:${weekPct.toFixed(0)}% 5h:${fiveHourPct.toFixed(0)}%`);
    } catch {
      setStatus(ctx, "GLM: error");
    }
  });

  pi.registerCommand("glm-usage", {
    description: "Show GLM coding plan quota usage",
    handler: async (_args, ctx) => {
      const apiKey = process.env.GLM_API_KEY;
      if (!apiKey) {
        ctx.ui.notify("GLM_API_KEY is not set", "error");
        return;
      }

      try {
        const payload = await fetchQuota(apiKey);
        const data = payload.data;
        if (!data?.limits?.length) {
          ctx.ui.notify(`GLM API error: ${payload.msg ?? "unexpected response"}`, "error");
          return;
        }

        const tokenLimit = data.limits.find((l) => l.type === "TOKENS_LIMIT");
        const lines: string[] = [];
        const level = data.level ? data.level.toUpperCase() : "GLM";
        lines.push(`GLM Coding Plan — ${level}`);

        if (tokenLimit) {
          const used = tokenLimit.currentValue ?? 0;
          const total = tokenLimit.usage ?? 0;
          const remaining = tokenLimit.remaining ?? total - used;
          const pct = tokenLimit.percentage ?? (total ? (used / total) * 100 : 0);
          lines.push("");
          lines.push(`Tokens:   ${formatTokens(used)} / ${formatTokens(total)} used (${pct.toFixed(1)}%)`);
          lines.push(`Remaining: ${formatTokens(remaining)}`);
          if (tokenLimit.nextResetTime) {
            lines.push(`Resets at: ${new Date(tokenLimit.nextResetTime).toLocaleString()}`);
          }
          if (tokenLimit.usageDetails?.length) {
            lines.push("");
            lines.push("Per-model usage:");
            for (const m of tokenLimit.usageDetails) {
              lines.push(`  ${m.modelCode}: ${formatTokens(m.usage)}`);
            }
          }
        } else {
          lines.push("(no TOKENS_LIMIT in response)");
        }

        const pct = tokenLimit?.percentage ?? 0;
        ctx.ui.notify(`GLM usage ${pct.toFixed(0)}%`, "info");
        await ctx.ui.select("GLM Coding Plan Usage", lines);
      } catch (err) {
        ctx.ui.notify(`GLM usage error: ${(err as Error).message}`, "error");
      }
    },
  });
}
