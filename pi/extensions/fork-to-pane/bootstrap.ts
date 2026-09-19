import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { restoreEditorFromHandoff } from "./session.ts";

/** One-shot bootstrap loaded only by the forked Pi process. */
export default function forkToPaneBootstrap(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    restoreEditorFromHandoff(ctx);
  });
}
