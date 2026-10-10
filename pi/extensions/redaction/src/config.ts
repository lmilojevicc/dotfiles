import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Detector, ExtensionConfig } from "./contracts.ts";

export const detectors: readonly Detector[] = ["email", "phone", "apiToken", "privateKey", "credentialUrl"];
export type ConfigState = { state: "inactive" | "active"; path: string; config: ExtensionConfig } | { state: "invalid"; path: string };
export function privateConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const base = env.XDG_CONFIG_HOME;
  return join(base && isAbsolute(base) ? base : join(home, ".config"), "pi-redaction", "config.json");
}
export function offConfig(): ExtensionConfig {
  return { literals: {}, detectors: { email: false, phone: false, apiToken: false, privateKey: false, credentialUrl: false }, sources: { toolResults: false, userMessages: false, systemPrompt: false } };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid redaction configuration");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Invalid redaction configuration");
}
export function validateConfig(value: unknown): ExtensionConfig {
  const root = object(value);
  keys(root, ["literals", "detectors", "sources"]);
  const config = offConfig();
  if (root.literals !== undefined) {
    const literals = object(root.literals);
    const aliases = new Set<string>();
    for (const [raw, alias] of Object.entries(literals)) {
      if (!raw || typeof alias !== "string" || !alias || aliases.has(alias)) throw new Error("Invalid redaction configuration");
      aliases.add(alias);
    }
    for (const alias of aliases) {
      if (Object.keys(literals).some(raw => alias.includes(raw) || raw.includes(alias))) throw new Error("Invalid redaction configuration");
    }
    config.literals = Object.fromEntries(Object.entries(literals)) as Record<string, string>;
  }
  for (const section of ["detectors", "sources"] as const) {
    if (root[section] === undefined) continue;
    const flags = object(root[section]);
    keys(flags, Object.keys(config[section]));
    for (const [name, flag] of Object.entries(flags)) {
      if (typeof flag !== "boolean") throw new Error("Invalid redaction configuration");
      (config[section] as Record<string, boolean>)[name] = flag;
    }
  }
  return config;
}
export function parseConfigJson(json: string): ExtensionConfig {
  try {
    const value: unknown = JSON.parse(json);
    // JSON.parse silently keeps the last duplicate key. Refuse ambiguous private policy instead.
    const stack: Array<{ keys: Set<string>; expectingKey: boolean } | null> = [];
    for (const token of json.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)) {
      const part = token[0];
      if (part === "{") stack.push({ keys: new Set(), expectingKey: true });
      else if (part === "[") stack.push(null);
      else if (part === "}" || part === "]") stack.pop();
      else {
        const frame = stack.at(-1);
        if (part === "," && frame) frame.expectingKey = true;
        else if (frame?.expectingKey && part.startsWith('"')) {
          const key: string = JSON.parse(part);
          if (frame.keys.has(key)) throw new Error();
          frame.keys.add(key);
          frame.expectingKey = false;
        }
      }
    }
    return validateConfig(value);
  } catch { throw new Error("Invalid redaction configuration"); }
}
export function isActive(config: ExtensionConfig): boolean {
  return Object.values(config.sources).some(Boolean) && (Object.keys(config.literals).length > 0 || Object.values(config.detectors).some(Boolean));
}
export async function loadConfig(path = privateConfigPath()): Promise<ConfigState> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    const parent = await stat(dirname(path));
    const uid = process.getuid?.();
    if (!info.isFile() || info.size > 1024 * 1024 || (info.mode & 0o077) !== 0 || (parent.mode & 0o022) !== 0 || (uid !== undefined && (info.uid !== uid || parent.uid !== uid))) return { state: "invalid", path };
    const config = parseConfigJson(await handle.readFile("utf8"));
    return { state: isActive(config) ? "active" : "inactive", path, config };
  } catch (error) {
    if (!handle && (error as NodeJS.ErrnoException).code === "ENOENT") return { state: "inactive", path, config: offConfig() };
    return { state: "invalid", path };
  } finally {
    await handle?.close().catch(() => {});
  }
}
export function safeStatus(state: ConfigState, failed = false): string {
  if (state.state === "invalid" || failed) return "Redaction unavailable: protected transmission censored; fix private configuration/native engine and reload.";
  return `Redaction ${state.state}; sources=${JSON.stringify(state.config.sources)}; detectors=${JSON.stringify(state.config.detectors)}; literals=${Object.keys(state.config.literals).length}`;
}
