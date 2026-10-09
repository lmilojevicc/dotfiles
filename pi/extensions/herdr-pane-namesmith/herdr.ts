import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

export interface HerdrTransportDependencies {
	connect: (path: string) => Pick<Socket, "on" | "write" | "destroy">;
	platform: NodeJS.Platform;
}

// The CLI treats `--` as label text; socket JSON preserves even option-shaped names.
export function renameHerdrPane(
	paneId: string,
	socketPath: string,
	name: string | undefined,
	dependencies: HerdrTransportDependencies = { connect: createConnection, platform: process.platform },
): Promise<void> {
	return new Promise((resolve, reject) => {
		const endpoint = dependencies.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
		const socket = dependencies.connect(endpoint);
		const id = randomUUID();
		let settled = false;
		let response = Buffer.alloc(0);
		const timeout = setTimeout(() => finish(new Error("Herdr rename timed out")), 2_000);
		function finish(error?: Error): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			if (error) reject(error);
			else resolve();
		}
		socket.on("error", () => finish(new Error("Herdr socket failed")));
		socket.on("end", () => finish(new Error("Herdr response ended early")));
		socket.on("close", () => finish(new Error("Herdr socket closed early")));
		socket.on("connect", () => {
			if (settled) return;
			try {
				socket.write(`${JSON.stringify({ id, method: "pane.rename", params: { pane_id: paneId, label: name ?? null } })}\n`);
			} catch {
				finish(new Error("Herdr request failed"));
			}
		});
		socket.on("data", (chunk: Buffer) => {
			if (settled) return;
			if (response.length + chunk.length > 16 * 1024) {
				finish(new Error("Herdr response too large"));
				return;
			}
			response = Buffer.concat([response, chunk]);
			const newline = response.indexOf(10);
			if (newline < 0) return;
			try {
				const message = JSON.parse(response.subarray(0, newline).toString("utf8"));
				if (!message || message.id !== id || "error" in message ||
					!message.result || typeof message.result !== "object" || Array.isArray(message.result)) {
					throw new Error("Invalid Herdr response");
				}
				finish();
			} catch {
				finish(new Error("Herdr rename rejected"));
			}
		});
	});
}
