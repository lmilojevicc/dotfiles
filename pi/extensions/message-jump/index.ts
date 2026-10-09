import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installBridge } from "./bridge.ts";
import { collectMessages } from "./messages.ts";
import { MessagePicker } from "./picker.ts";

export default function messageJump(pi: ExtensionAPI): void {
	const bridge = installBridge(Symbol("message-jump-owner"));
	let active: MessagePicker | undefined;
	let generation = 0;
	const cancel = () => { generation++; active?.cancel(); active = undefined; };
	pi.on("session_start", cancel);
	pi.on("session_shutdown", (event) => { cancel(); bridge.release(event.reason === "quit"); });
	pi.registerCommand("jump", {
		description: "Search active-branch user messages and scroll the fullscreen transcript",
		handler: async (query, ctx) => {
			const notify = (error: string) => { if (ctx.hasUI) ctx.ui.notify(error, "warning"); else console.error(`/jump: ${error}`); };
			if (ctx.mode !== "tui" || !ctx.hasUI) { notify("Requires interactive fullscreen Pi. Start Pi interactively and choose fullscreen in /settings."); return; }
			const failure = bridge.error();
			if (failure) { notify(failure); return; }
			if (active) { notify("A /jump picker is already open; cancel it first."); return; }
			const sessionId = ctx.sessionManager.getSessionId();
			const token = generation;
			const messages = collectMessages(ctx.sessionManager.getBranch());
			if (!messages.length) { notify("No user messages on the active branch."); return; }
			for (const item of messages) item.unavailable = bridge.unavailable(item);
			let id: string | undefined;
			let picker: MessagePicker | undefined;
			try {
				id = await ctx.ui.custom<string | undefined>((tui, theme, kb, done) => {
					picker = new MessagePicker(messages, tui, theme, kb, done, query);
					active = picker;
					return picker;
				}, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" } });
			} finally { if (active === picker) active = undefined; }
			if (id === undefined) return;
			if (token !== generation || sessionId !== ctx.sessionManager.getSessionId()) { notify("Session changed while /jump was open. Run /jump again."); return; }
			// Re-resolve by stable ID on the current branch, after any streaming, tree change or compaction.
			const current = collectMessages(ctx.sessionManager.getBranch()).find((item) => item.id === id);
			const selected = messages.find((item) => item.id === id);
			if (!current || current.message !== selected?.message) { notify("Selected message is no longer on the active branch. Run /jump again."); return; }
			const error = bridge.jump(current);
			if (error) notify(error);
		},
	});
}
