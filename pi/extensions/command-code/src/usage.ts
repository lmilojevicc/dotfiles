import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { mergeHeaders } from "./stream.ts";

const USAGE_BASE_URL = "https://api.commandcode.ai";
export const COMMAND_CODE_USAGE_LIMITS = Object.freeze({ responseBytes: 256 * 1024, timeoutMs: 15_000 });

export const COMMAND_CODE_PLANS = Object.freeze([
  { id: "individual-provider", name: "Provider", monthlyBaseline: 15 },
  { id: "individual-pro-v1", name: "Pro", monthlyBaseline: 80 },
  { id: "individual-ultra", name: "Ultra", monthlyBaseline: 300 },
  { id: "individual-goat", name: "GOAT", monthlyBaseline: 70 },
  { id: "individual-max", name: "Max", monthlyBaseline: 150 },
  { id: "individual-pro", name: "Pro", monthlyBaseline: 30 },
  { id: "individual-go", name: "Go", monthlyBaseline: 10 },
  { id: "teams-pro", name: "Teams Pro", monthlyBaseline: 40 },
].sort((left, right) => right.id.length - left.id.length));

export type UsageWindow = { percentage: number; resetAt: number | null };
export type CommandCodeUsageView = {
  plan: string;
  status: string;
  percentage: number;
  cycleAvailable: boolean;
  creditsLeft: number;
  requests: number;
  daysToRenewal: number | null;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  usageUrl: string | null;
};

type FetchLike = typeof globalThis.fetch;
type JsonObject = Record<string, unknown>;
type FetchUsageOptions = {
  apiKey: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: number;
};
type JsonValidator = (value: JsonObject) => boolean;

export class CommandCodeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandCodeUsageError";
  }
}

class UsageProtocolError extends CommandCodeUsageError {}

class UsageHttpError extends CommandCodeUsageError {
  readonly status: number;

  constructor(status: number) {
    super(status === 401 || status === 403
      ? "Command Code session expired. Run `cmd login`."
      : status === 429
        ? "Command Code usage is temporarily unavailable (429)."
        : status >= 500
          ? "Command Code usage is temporarily unavailable."
          : `Command Code usage request failed (${status}).`);
    this.status = status;
  }
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function has(root: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(root, key);
}

function optionalObject(value: unknown): boolean {
  return value === null || value === undefined || object(value) !== null;
}

function optionalString(value: unknown): boolean {
  return value === null || value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): boolean {
  return value === null || value === undefined || typeof value === "boolean";
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function finiteNonnegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function clampPercentage(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

function validWindow(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const window = object(value);
  return window !== null
    && typeof window.used === "number" && Number.isFinite(window.used)
    && typeof window.cap === "number" && Number.isFinite(window.cap)
    && typeof window.resetAt === "number" && Number.isFinite(window.resetAt);
}

const validateWhoami: JsonValidator = (data) => {
  if (!has(data, "org") && !has(data, "user")) return false;
  if (!optionalObject(data.org) || !optionalObject(data.user)) return false;
  const org = object(data.org);
  const user = object(data.user);
  return (!org || (optionalString(org.id) || typeof org.id === "number") && optionalString(org.login))
    && (!user || optionalString(user.userName));
};

const validateCredits: JsonValidator = (data) => {
  if (!has(data, "credits")) return false;
  const credits = object(data.credits);
  if (!credits) return false;
  if (!optionalString(credits.planId)
    || !optionalFiniteNumber(credits.monthlyCredits)
    || !optionalFiniteNumber(credits.purchasedCredits)
    || !optionalFiniteNumber(credits.freeCredits)) return false;
  if (!optionalObject(data.windowLimits)) return false;
  const limits = object(data.windowLimits);
  return !limits || (optionalBoolean(limits.limited) && validWindow(limits.fiveHour) && validWindow(limits.weekly));
};

const validateSubscription: JsonValidator = (data) => {
  if (!has(data, "success") || typeof data.success !== "boolean" || !has(data, "data")) return false;
  if (data.success === false) return data.data === null;
  const subscription = object(data.data);
  return subscription !== null
    && has(subscription, "planId") && typeof subscription.planId === "string"
    && has(subscription, "status") && typeof subscription.status === "string"
    && has(subscription, "currentPeriodStart") && (subscription.currentPeriodStart === null || typeof subscription.currentPeriodStart === "string")
    && has(subscription, "currentPeriodEnd") && (subscription.currentPeriodEnd === null || typeof subscription.currentPeriodEnd === "string");
};

const validateSummary: JsonValidator = (data) =>
  typeof data.totalCost === "number" && Number.isFinite(data.totalCost) && data.totalCost >= 0
  && typeof data.totalCount === "number" && Number.isFinite(data.totalCount) && data.totalCount >= 0;

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readBoundedJson(response: Response, signal: AbortSignal, validate: JsonValidator): Promise<JsonObject> {
  if (!response.body) throw new UsageProtocolError("Command Code returned invalid usage data.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) {
        complete = true;
        break;
      }
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > COMMAND_CODE_USAGE_LIMITS.responseBytes) {
        throw new UsageProtocolError("Command Code usage response exceeded the size limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    const result = object(JSON.parse(text));
    if (!result || !validate(result)) throw new Error("invalid shape");
    return result;
  } catch {
    throw new UsageProtocolError("Command Code returned invalid usage data.");
  }
}

async function getJson(
  path: string,
  query: Record<string, string | null>,
  apiKey: string,
  fetch: FetchLike,
  signal: AbortSignal,
  validate: JsonValidator,
): Promise<JsonObject> {
  signal.throwIfAborted();
  const url = new URL(path, USAGE_BASE_URL);
  for (const [key, value] of Object.entries(query)) if (value !== null) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: mergeHeaders(apiKey),
      signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new CommandCodeUsageError("Unable to reach Command Code.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new UsageHttpError(response.status);
  }
  return await readBoundedJson(response, signal, validate);
}

function optionalRequest<T>(promise: Promise<T>): Promise<T | null> {
  return promise.catch((error: unknown) => {
    if (error instanceof UsageProtocolError) throw error;
    if (error instanceof UsageHttpError && (error.status === 401 || error.status === 403)) throw error;
    if (!(error instanceof CommandCodeUsageError)) throw error;
    return null;
  });
}

function nested(root: JsonObject | null, key: string): JsonObject | null {
  return root ? object(root[key]) : null;
}

function string(root: JsonObject | null, key: string): string | null {
  return root && typeof root[key] === "string" && root[key] ? root[key] as string : null;
}

export function normalizePlan(planId: string | null): { name: string; monthlyBaseline: number | null } {
  if (!planId) return { name: "Unknown", monthlyBaseline: null };
  const normalized = planId.toLowerCase().replaceAll("_", "-").replace(/[^a-z0-9-]/g, "").slice(0, 64);
  const known = COMMAND_CODE_PLANS.find((plan) => normalized.startsWith(plan.id));
  if (known) return { name: known.name, monthlyBaseline: known.monthlyBaseline };
  const label = normalized.replace(/^individual-/, "").split("-").filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
  return { name: label || "Unknown", monthlyBaseline: null };
}

function projectWindow(value: unknown): UsageWindow | null {
  const data = object(value);
  if (!data) return null;
  const used = finiteNonnegative(data.used);
  const cap = finiteNonnegative(data.cap);
  const resetAt = typeof data.resetAt === "number" && Number.isFinite(data.resetAt) ? data.resetAt : null;
  return { percentage: cap > 0 ? clampPercentage(used / cap * 100) : 0, resetAt };
}

function displayStatus(value: string | null): { display: string; normalized: string } {
  const display = value?.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim().slice(0, 64) || "unknown";
  return { display, normalized: display.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) };
}

export function projectCommandCodeUsage(
  whoami: JsonObject,
  creditsResponse: JsonObject | null,
  subscriptionResponse: JsonObject | null,
  summaryResponse: JsonObject | null,
  now = Date.now(),
): CommandCodeUsageView {
  const credits = nested(creditsResponse, "credits");
  const subscription = nested(subscriptionResponse, "data");
  const planId = string(subscription, "planId") ?? string(credits, "planId");
  const plan = normalizePlan(planId);
  const status = displayStatus(string(subscription, "status"));
  const monthly = finiteNonnegative(credits?.monthlyCredits);
  const purchased = finiteNonnegative(credits?.purchasedCredits);
  const free = finiteNonnegative(credits?.freeCredits);
  const creditsLeft = monthly + purchased + free;
  const spent = finiteNonnegative(summaryResponse?.totalCost);
  const baseline = status.normalized === "active" ? plan.monthlyBaseline : null;
  const total = baseline === null ? spent + creditsLeft : Math.max(baseline, monthly) + purchased + free;
  const percentage = spent > 0 || creditsLeft > 0 ? clampPercentage(total > 0 ? (total - creditsLeft) / total * 100 : 0) : 0;
  const requests = finiteNonnegative(summaryResponse?.totalCount);

  const periodEnd = string(subscription, "currentPeriodEnd");
  const parsedEnd = periodEnd ? Date.parse(periodEnd) : Number.NaN;
  const daysToRenewal = Number.isFinite(parsedEnd) ? Math.max(0, Math.ceil((parsedEnd - now) / 86_400_000)) : null;

  const limits = nested(creditsResponse, "windowLimits");
  const limited = limits?.limited === true;
  const org = nested(whoami, "org");
  const user = nested(whoami, "user");
  const slug = string(org, "login") ?? string(user, "userName");
  const safeSlug = slug && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(slug) ? slug : null;

  return {
    plan: plan.name,
    status: status.display,
    percentage,
    cycleAvailable: summaryResponse !== null,
    creditsLeft,
    requests,
    daysToRenewal,
    fiveHour: limited ? projectWindow(limits?.fiveHour) : null,
    weekly: limited ? projectWindow(limits?.weekly) : null,
    usageUrl: safeSlug ? `https://commandcode.ai/${safeSlug}/settings/usage` : null,
  };
}

export async function fetchCommandCodeUsage(options: FetchUsageOptions): Promise<CommandCodeUsageView> {
  const fetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, Math.max(1, options.timeoutMs ?? COMMAND_CODE_USAGE_LIMITS.timeoutMs));
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const whoami = await getJson("/alpha/whoami", {}, options.apiKey, fetch, controller.signal, validateWhoami);
    const org = nested(whoami, "org");
    const orgIdValue = org?.id;
    const orgId = typeof orgIdValue === "string" || typeof orgIdValue === "number" ? String(orgIdValue) : null;
    const query = { orgId };
    const [credits, subscriptions] = await Promise.all([
      optionalRequest(getJson("/alpha/billing/credits", query, options.apiKey, fetch, controller.signal, validateCredits)),
      optionalRequest(getJson("/alpha/billing/subscriptions", query, options.apiKey, fetch, controller.signal, validateSubscription)),
    ]);
    const periodStart = string(nested(subscriptions, "data"), "currentPeriodStart");
    const summary = periodStart === null ? null : await optionalRequest(getJson(
      "/alpha/usage/summary",
      { orgId, since: periodStart },
      options.apiKey,
      fetch,
      controller.signal,
      validateSummary,
    ));
    if (!credits && !subscriptions && !summary) throw new CommandCodeUsageError("Command Code usage is temporarily unavailable.");
    return projectCommandCodeUsage(whoami, credits, subscriptions, summary, options.now);
  } catch (error) {
    if (error instanceof CommandCodeUsageError) throw error;
    if (timedOut) throw new CommandCodeUsageError("Command Code usage request timed out.");
    if (options.signal?.aborted) throw new CommandCodeUsageError("Command Code usage request cancelled.");
    throw new CommandCodeUsageError("Unable to reach Command Code.");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (!controller.signal.aborted) controller.abort();
  }
}

export function formatDuration(milliseconds: number): string {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ""}`;
  return `${remainingMinutes}m`;
}

function bar(percentage: number, cells: number): string {
  const count = Math.max(1, cells);
  const filled = Math.round(clampPercentage(percentage) / 100 * count);
  return `${"█".repeat(filled)}${"░".repeat(count - filled)}`;
}

function wrap(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const lines = wrapTextWithAnsi(text, limit);
  return (lines.length ? lines : [""]).map((line) => visibleWidth(line) <= limit ? line : truncateToWidth(line, limit, ""));
}

function meterLines(label: string, window: UsageWindow | null, width: number, now: number): string[] {
  if (!window) return wrap(`${label} unavailable`, width);
  const percentage = Math.round(clampPercentage(window.percentage));
  const reset = window.resetAt !== null && window.resetAt > now ? ` · resets in ${formatDuration(window.resetAt - now)}` : "";
  const suffix = ` ${percentage}%${reset}`;
  const fullCells = 30;
  const inlineCells = width - visibleWidth(label) - 1 - visibleWidth(suffix);
  if (inlineCells >= 8) return [`${label} ${bar(percentage, Math.min(fullCells, inlineCells))}${suffix}`];
  return [
    ...wrap(label, width),
    `${bar(percentage, Math.max(1, Math.min(fullCells, width - visibleWidth(`${percentage}%`) - 1)))} ${percentage}%`,
    ...wrap(reset.replace(/^ · /, ""), width).filter(Boolean),
  ];
}

export function renderCommandCodeUsage(view: CommandCodeUsageView, width: number, now = Date.now()): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const percent = Math.round(clampPercentage(view.percentage));
  const cycleParts = [
    `$${view.creditsLeft.toFixed(2)} left`,
    `${view.requests.toLocaleString("en-US")} requests`,
    view.daysToRenewal === null ? null : view.daysToRenewal === 0 ? "renewal today" : `${view.daysToRenewal} day${view.daysToRenewal === 1 ? "" : "s"} to renewal`,
  ].filter((part): part is string => part !== null);
  const mainSuffix = ` ${percent}% used`;
  const mainCells = Math.max(1, Math.min(30, safeWidth - visibleWidth(mainSuffix)));
  const cycleLines = view.cycleAvailable
    ? [
        ...wrap(`${bar(percent, mainCells)}${mainSuffix}`, safeWidth),
        ...wrap(`Cycle: ${cycleParts.join(" · ")}`, safeWidth),
      ]
    : wrap("Cycle: unavailable", safeWidth);
  const lines = [
    ...wrap(`USAGE ${view.plan} Plan · ${view.status}`, safeWidth),
    "",
    ...cycleLines,
    "",
    ...wrap("Usage limits", safeWidth),
    ...meterLines("5-hour", view.fiveHour, safeWidth, now),
    "",
    ...meterLines("Weekly", view.weekly, safeWidth, now),
  ];
  if (view.usageUrl) lines.push("", ...wrap(`Full breakdown at ${view.usageUrl}`, safeWidth));
  lines.push("", ...wrap("Press Enter or Escape to close", safeWidth));
  return lines.flatMap((line) => visibleWidth(line) <= safeWidth ? [line] : wrap(line, safeWidth));
}
