import { installedHost } from "../installed-host.mjs";
import { pathToFileURL } from "node:url";
export const { DynamicBorder } = await import(pathToFileURL(`${installedHost()}/dist/modes/interactive/components/dynamic-border.js`).href);
import { Spacer, Text } from "@earendil-works/pi-tui";
export const VERSION = "1.0.4";
// Focused tests inject picker.onCopy; never change the real system clipboard.
export async function copyToClipboard() { throw new Error("Unexpected system clipboard access in test"); }
export class InteractiveMode {
  mountInteractiveTui(tui, components) { this.mountCalls = (this.mountCalls || 0) + 1; }
  addMessageToChat(message, options) {
    this.addCalls = (this.addCalls || 0) + 1;
    if (message.role !== "user") return;
    const text = typeof message.content === "string" ? message.content : (message.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    if (!text) return;
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(text, 0, 0));
    if (options?.skill) { this.chatContainer.addChild(new Spacer(1)); this.chatContainer.addChild(new Text("skill-user", 0, 0)); }
  }
}
