// Test-only observer, loaded by the offline PTY driver, never by normal package discovery.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
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
					model: ctx.model, session: ctx.sessionManager.getSessionId(),
				};
				const messages = collectMessages(ctx.sessionManager.getBranch());
				const query = stage === "layout" ? "" : stage === "live" || stage === "new" ? "live duplicate" : "restored duplicate";
				const candidates = messages.filter(item => item.text.includes(query));
				assert.equal(candidates.length, stage === "layout" ? 30 : 2);
				const chosen = candidates[stage === "older" ? 0 : candidates.length - 1];
				if (stage !== "compacted") assert.ok(record.targets.get(chosen.message), "restored stable entry maps to actual component");
				let warning = "";
				const ui = { ...ctx.ui, notify: (s: string) => { warning = s; } };
				const originalCustom = ctx.ui.custom;
				ui.custom = (factory: any, options: any) => {
					assert.equal(options, undefined, "public inline custom UI, never an overlay");
					return originalCustom(async (...args: any[]) => {
						const picker = factory(...args);
						if (stage === "copy") picker.onCopy = (text: string) => {
							assert.equal(text, chosen.text, "Ctrl+Y copies the highlighted full text");
							report("copied", { stage }); // Test-only clipboard sink; never mutate the user's clipboard.
						};
						// Probe-only mutation after custom() has saved the draft proves its internal restoration.
						mode.editor.setText("probe-only hidden editor change");
						// Test-only native source oracle. It is rendered offscreen, never mounted.
						let native: any;
						if (stage === "layout") {
							const root = process.env.MESSAGE_JUMP_PI_ROOT!;
							const { UserMessageSelectorComponent } = await import(pathToFileURL(`${root}/dist/modes/interactive/components/user-message-selector.js`).href);
							native = new UserMessageSelectorComponent(messages.map(item => ({ id: item.id, text: item.preview })), () => {}, () => {});
							// Substitute only the jump-specific copy, retaining native header components/spacing.
							native.children[1] = new Text(args[1].bold("Jump to Message"), 1, 0);
							native.children[2] = new Text(args[1].fg("muted", "Select a user message to scroll to in the current transcript"), 1, 0);
						}
						const render = picker.render.bind(picker);
						const seen = new Set<string>();
						picker.render = (width: number) => {
							const lines = render(width);
							try {
								assert.ok(mode.editorContainer.children.includes(picker), "mounted inline in native editor container");
								assert.equal(mode.renderer.getFocusedComponent(), picker);
								assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
								if (native) {
									const headerRows = native.children[1].render(width).length + native.children[2].render(width).length;
									native.getMessageList().maxVisible = Math.max(1, Math.min(10, Math.floor((mode.renderer.terminal.rows - headerRows - 12) / 3)));
									const expected = native.render(width).map((line: string) => line.trimEnd());
									const searchIndex = 1 + native.children[1].render(width).length + native.children[2].render(width).length;
									const actual = lines.filter((_: string, i: number) => i !== searchIndex).map((line: string) => line.trimEnd());
									assert.deepEqual(actual, expected, "native /fork source snapshot: spacing, borders, prompts, metadata, caret, bold and position indicator");
									const key = `${width}x${mode.renderer.terminal.rows}`;
									if (!seen.has(key)) { seen.add(key); report("native-layout", { stage, dimensions: key, snapshot: lines.map((line: string) => stripVTControlCharacters(line).trimEnd()) }); }
								}
							} catch (error) { report("failure", { error: String(error), stack: (error as Error).stack }); }
							if (!seen.has("opened")) { seen.add("opened"); report("opened", { stage }); }
							return lines;
						};
						return picker;
					}, options);
				};
				await jump(query, { ...ctx, ui });
				assert.equal(ctx.sessionManager.getSessionId(), before.session);
				assert.equal(ctx.model, before.model);
				assert.equal(ctx.sessionManager.getLeafId(), before.leaf);
				assert.equal(JSON.stringify(ctx.sessionManager.getBranch()), before.entries);
				assert.equal(JSON.stringify(ctx.sessionManager.buildContextEntries()), before.context);
				assert.equal(ctx.ui.getEditorText(), before.draft, "public inline custom restores its saved draft internally");
				assert.equal(mode.renderer.getFocusedComponent(), before.focus);
				if (stage === "cancel" || stage === "layout" || stage === "copy") assert.equal(mode.transcriptScrollView.scrollTop, before.scroll);
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
