// Test-only observer, loaded by the offline PTY driver, never by normal package discovery.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { InteractiveMode, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectMessages } from "../messages.ts";
const report = (event: string, details = {}) => appendFileSync(process.env.MESSAGE_JUMP_REPORT!, `${JSON.stringify({ event, ...details })}\n`);
const globals = globalThis as any;

export default function (pi: ExtensionAPI) {
	assert.equal(VERSION, "1.0.4");
	const record = globals[Symbol.for("dotfiles.message-jump.bridge.v1")];
	assert.equal(record.prototype, InteractiveMode.prototype);
	pi.on("session_start", (event) => { report(event.reason === "reload" ? "reloaded" : event.reason === "new" ? "switched" : "ready"); });
	pi.on("input", (_event, ctx) => { report("failure", { error: "No model input permitted" }); ctx.shutdown(); return { action: "handled" }; });
	pi.registerCommand("jump-smoke", {
		handler: async (stage, ctx) => {
			try {
				const mode = record.host;
				assert.ok(mode instanceof InteractiveMode, "CLI and extension share the live InteractiveMode class");
				const jump = mode.session.extensionRunner.getCommand("jump").handler;
				if (stage === "unsupported") {
					let warning = "";
					await jump("", { ...ctx, ui: { ...ctx.ui, notify: (s: string) => { warning = s; } } });
					assert.match(warning, /fullscreen/); report(stage); return;
				}
				if (stage === "empty") {
					let warning = "";
					await jump("", { ...ctx, ui: { ...ctx.ui, notify: (s: string) => { warning = s; } } });
					assert.match(warning, /No user messages/); report(stage); return;
				}
				if (stage === "live" || stage === "new") {
					for (const text of ["live duplicate", "live duplicate", "tail " + "line\n".repeat(80)]) {
						const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
						await mode.session._handleAgentEvent({ type: "message_start", message });
						await mode.session._handleAgentEvent({ type: "message_end", message });
						const persisted = mode.sessionManager.getLeafEntry();
						assert.equal(persisted.message, message, "real message_start → message_end persistence preserves identity");
						assert.ok(record.targets.get(persisted.message), "actual live user component mapped");
					}
				}
				if (stage === "compacted") {
					mode.sessionManager.appendCompaction("Offline smoke summary", "entry-20", 1000);
					mode.rebuildChatFromMessages();
				}
				mode.renderer.renderNow();
				mode.transcriptScrollView.scrollToStart();
				mode.renderer.renderNow();
				ctx.ui.setEditorText("preserve this draft 世界");
				const before = {
					leaf: ctx.sessionManager.getLeafId(), entries: JSON.stringify(ctx.sessionManager.getBranch()),
					context: JSON.stringify(ctx.sessionManager.buildContextEntries()), draft: ctx.ui.getEditorText(),
					focus: mode.renderer.getFocusedComponent(), scroll: mode.transcriptScrollView.scrollTop,
				};
				const messages = collectMessages(ctx.sessionManager.getBranch());
				const query = stage === "live" || stage === "new" ? "live duplicate" : "restored duplicate";
				const candidates = messages.filter(item => item.text.includes(query));
				assert.equal(candidates.length, 2);
				const chosen = candidates[stage === "older" ? 1 : 0];
				if (stage !== "compacted") assert.ok(record.targets.get(chosen.message), "restored stable entry maps to actual component");
				let warning = "";
				const ui = { ...ctx.ui, notify: (s: string) => { warning = s; } };
				const originalCustom = ctx.ui.custom;
				ui.custom = (factory: any, options: any) => originalCustom((...args: any[]) => {
					const picker = factory(...args); report("opened", { stage }); return picker;
				}, options);
				await jump(query, { ...ctx, ui });
				assert.equal(ctx.sessionManager.getLeafId(), before.leaf);
				assert.equal(JSON.stringify(ctx.sessionManager.getBranch()), before.entries);
				assert.equal(JSON.stringify(ctx.sessionManager.buildContextEntries()), before.context);
				assert.equal(ctx.ui.getEditorText(), before.draft);
				assert.equal(mode.renderer.getFocusedComponent(), before.focus);
				if (stage === "cancel") assert.equal(mode.transcriptScrollView.scrollTop, before.scroll);
				else if (stage === "compacted") { assert.match(warning, /Not rendered/); assert.equal(mode.transcriptScrollView.scrollTop, before.scroll); }
				else {
					assert.equal(warning, "");
					const width = mode.transcriptScrollView.getContentWidth(mode.renderer.terminal.columns);
					const target = record.targets.get(chosen.message);
					let row = 0;
					for (const child of mode.documentContainer.children) { if (child === mode.chatContainer) break; row += child.render(width).length; }
					for (const child of mode.chatContainer.children) { if (child === target) break; row += child.render(width).length; }
					assert.ok(row > 0);
					assert.equal(mode.transcriptScrollView.scrollTop, row, "real viewport lands on selected stable entry");
					assert.equal(mode.transcriptScrollView.isFollowingEnd, false);
				}
				ctx.ui.setEditorText(""); // Probe-only cleanup so the driver can submit the next command.
				report(stage, { scroll: mode.transcriptScrollView.scrollTop, id: chosen.id, columns: mode.renderer.terminal.columns });
			} catch (error) { report("failure", { error: String(error), stack: (error as Error).stack }); ctx.shutdown(); }
		},
	});
}
