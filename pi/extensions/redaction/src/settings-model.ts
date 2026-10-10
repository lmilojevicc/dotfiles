import type { ExtensionConfig } from "./contracts.ts";
import type { MenuSection } from "./menu-contracts.ts";
import { isActive, validateConfig } from "./config.ts";

export const sections: readonly MenuSection[] = ["detectors", "sources", "replacements"];
export const sectionLabels = { detectors: "Redact", sources: "Sources", replacements: "Replacements" } as const;
export const sourceLabels = { toolResults: "Tool results", userMessages: "User messages", systemPrompt: "System prompt" } as const;
export const detectorLabels = { email: "Emails", phone: "Phone numbers", apiToken: "API keys", privateKey: "Private keys", credentialUrl: "Credential URLs" } as const;
export function cloneDraft(config: ExtensionConfig): ExtensionConfig {
  return { sources: { ...config.sources }, detectors: { ...config.detectors }, literals: Object.fromEntries(Object.entries(config.literals)) };
}
export function sameConfig(a: ExtensionConfig, b: ExtensionConfig): boolean {
  return (["sources", "detectors", "literals"] as const).every(section => {
    const keys = Object.keys(a[section]);
    return keys.length === Object.keys(b[section]).length && keys.every(key => Object.hasOwn(b[section], key) && (a[section] as Record<string, unknown>)[key] === (b[section] as Record<string, unknown>)[key]);
  });
}
export function reducedProtection(before: ExtensionConfig, after: ExtensionConfig): boolean {
  if (!isActive(before)) return false;
  return Object.keys(before.sources).some(key => before.sources[key as keyof typeof before.sources] && !after.sources[key as keyof typeof after.sources]) ||
    Object.keys(before.detectors).some(key => before.detectors[key as keyof typeof before.detectors] && !after.detectors[key as keyof typeof after.detectors]) ||
    Object.keys(before.literals).some(key => !Object.hasOwn(after.literals, key));
}
/** Aliases are untrusted labels, not terminal markup. Originals never reach this function. */
export function safeAlias(alias: string): string {
  return Array.from(alias.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "�")).slice(0, 120).join("");
}
export function needsEscaped(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}
export function replaceLiteral(draft: ExtensionConfig, index: number | undefined, original: string, alias: string): void {
  const entries = Object.entries(draft.literals);
  if (!original || !alias || entries.some(([key], i) => key === original && i !== index)) throw new Error("Invalid replacement");
  if (index === undefined) entries.push([original, alias]);
  else if (entries[index]) entries[index] = [original, alias];
  else throw new Error("Invalid replacement");
  const next = { ...draft, literals: Object.fromEntries(entries) };
  validateConfig(next);
  draft.literals = next.literals;
}
export function deleteLiteral(draft: ExtensionConfig, index: number): void {
  draft.literals = Object.fromEntries(Object.entries(draft.literals).filter((_, i) => i !== index));
}
export function draftState(config: ExtensionConfig): string {
  const sources = Object.values(config.sources).some(Boolean);
  const rules = Object.values(config.detectors).some(Boolean) || Object.keys(config.literals).length > 0;
  return rules && !sources ? "Choose a source in Sources" : sources && !rules ? "Choose what to redact" : "";
}
