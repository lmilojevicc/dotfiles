import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionConfig } from "./contracts.ts";
import type { PrivateConfigStore } from "./menu-contracts.ts";
import { validateConfig } from "./config.ts";
import { cloneDraft, deleteLiteral, reducedProtection, replaceLiteral, sameConfig } from "./settings-model.ts";
import type { SettingsUI } from "./settings-ui.ts";

export interface SettingsDependencies {
  store: PrivateConfigStore;
  ui: SettingsUI;
  validateNative(config: ExtensionConfig): void | Promise<void>;
}
const storeMessages: Record<string, string> = {
  invalid: "Private configuration is invalid. Repair it manually before reopening /redaction.",
  unsafe: "Private configuration storage is unsafe. Repair ownership/permissions before reopening /redaction.",
  conflict: "Private configuration changed elsewhere. Reopen /redaction before saving.",
  busy: "Private configuration is busy. Try again shortly.",
  io: "Could not access private configuration. Check private storage and try again.",
};
function storeMessage(error: unknown): string {
  // Never stringify errors, paths, revisions, or private values.
  try {
    const code = (error as { code?: unknown })?.code;
    return typeof code === "string" && Object.hasOwn(storeMessages, code) ? storeMessages[code] : storeMessages.io;
  } catch { return storeMessages.io; }
}

export async function runSettingsCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext,
  running: { summary: string; config?: ExtensionConfig }, load: () => Promise<SettingsDependencies>): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("/redaction requires local TUI mode.", "warning");
    return;
  }
  if (args.trim()) { ctx.ui.notify("Usage: /redaction", "warning"); return; }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const unsubscribers = [pi.on("session_shutdown", abort), pi.on("session_before_switch", abort), pi.on("session_tree", abort)];
  ctx.signal?.addEventListener("abort", abort, { once: true });
  if (ctx.signal?.aborted) abort();
  const current = () => !controller.signal.aborted;
  let reload: (() => Promise<void>) | undefined;
  try {
    const deps = await load();
    if (!current()) return;
    let snapshot;
    try { snapshot = await deps.store.read(); }
    catch (error) { if (current()) ctx.ui.notify(storeMessage(error), "error"); return; }
    if (!current()) return;
    const draft = cloneDraft(snapshot.config);
    const ui = deps.ui;
    while (current()) {
      // Expand only the existing main prompt before Pi snapshots it. Private forms never use this editor.
      const prompt = ctx.ui.getEditorText();
      if (prompt) ctx.ui.setEditorText(prompt);
      const outcome = await ui.menu(ctx, draft, snapshot.config, running.summary, controller.signal);
      if (!current()) return;
      if (outcome.kind === "cancel") {
        if (sameConfig(draft, snapshot.config) || await ui.confirm(ctx, "Discard pending changes?", controller.signal)) return;
      } else if (outcome.kind === "add" || outcome.kind === "edit") {
        const index = outcome.kind === "edit" ? outcome.index : undefined;
        const entry = index === undefined ? undefined : Object.entries(draft.literals)[index];
        const value = await ui.form(ctx, entry, controller.signal);
        if (!current()) return;
        if (value) {
          try { replaceLiteral(draft, index, value[0], value[1]); }
          catch { ctx.ui.notify("Invalid replacement: use nonempty, unique values and aliases without overlap.", "error"); }
        }
      } else if (outcome.kind === "delete") {
        if (await ui.confirm(ctx, "Delete this replacement from the draft?", controller.signal) && current()) deleteLiteral(draft, outcome.index);
      } else if (outcome.kind === "save") {
        let checked: ExtensionConfig;
        try { checked = validateConfig(draft); }
        catch { ctx.ui.notify("Invalid redaction draft. Review replacements before saving.", "error"); continue; }
        if (!current()) return;
        // Every UI interaction is closed before waiting, validation, persistence and reload.
        await ctx.waitForIdle();
        if (!current()) return;
        if (Object.keys(checked.literals).length || Object.values(checked.detectors).some(Boolean)) {
          try { await deps.validateNative(checked); }
          catch {
            if (current()) ctx.ui.notify("Native validation unavailable or draft incompatible. Build with node scripts/build-native.mjs in the redaction package, then review rules and retry.", "error");
            continue;
          }
        }
        if (!current()) return;
        if (reducedProtection(snapshot.config, checked) || (running.config && reducedProtection(running.config, checked))) {
          if (!await ui.confirm(ctx, "Reduce protection? Previously protected content may be exposed.", controller.signal)) continue;
        }
        if (!current()) return;
        // A confirmation is closed too; recheck idle immediately before starting persistence.
        await ctx.waitForIdle();
        if (!current()) return;
        let applied;
        try { applied = await deps.store.save(snapshot, checked); }
        catch (error) { if (current()) ctx.ui.notify(storeMessage(error), "error"); return; }
        if (!current()) return;
        if (applied.warnings?.length) {
          // Persistence has committed: neither notification failure nor a warning warrants another save.
          try { ctx.ui.notify("Configuration saved with a storage warning: crash durability or temporary cleanup may be incomplete. Reloading Pi.", "warning"); } catch {}
        }
        if (!current()) return;
        reload = () => ctx.reload();
        break;
      }
    }
  } catch {
    if (current()) ctx.ui.notify("Could not open redaction settings safely. No runtime changes applied.", "error");
  } finally {
    for (const unsubscribe of unsubscribers) unsubscribe();
    ctx.signal?.removeEventListener("abort", abort);
  }
  // No old context, UI, configuration, or engine is used after reload settles (even on failure).
  if (reload) {
    try { await reload(); }
    catch { throw new Error("Redaction configuration saved; reload failed. Restart Pi before relying on the saved policy."); }
  }
}

export async function openSettings(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, running: { summary: string; config?: ExtensionConfig }): Promise<void> {
  await runSettingsCommand(pi, args, ctx, running, async () => {
    // Store is supplied by the independent persistence seam at integration. Keep all optional modules cold.
    const storeModule = "./config-store.ts";
    const [{ createPrivateConfigStore }, { createSettingsUI }, { createNativeRedactor }] = await Promise.all([
      import(storeModule) as Promise<{ createPrivateConfigStore(): PrivateConfigStore }>,
      import("./settings-ui.ts"), import("./native.ts"),
    ]);
    return { store: createPrivateConfigStore(), ui: createSettingsUI(), validateNative(config) {
      const engine = createNativeRedactor(config);
      try { engine.redact(""); } finally { engine.reset(); }
    } };
  });
}
