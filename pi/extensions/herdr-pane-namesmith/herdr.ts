import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

export interface HerdrTransportDependencies {
	connect: (path: string) => Pick<Socket, "on" | "write" | "destroy">;
	platform: NodeJS.Platform;
}

const defaultTransport: HerdrTransportDependencies = { connect: createConnection, platform: process.platform };

// Single-shot request/response over the Herdr socket API; the CLI treats `--` as
// label text, so socket JSON is the only lossless transport for pane labels.
function request(
	socketPath: string,
	method: "pane.get" | "pane.rename",
	params: Record<string, unknown>,
	label: string,
	dependencies: HerdrTransportDependencies,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const endpoint = dependencies.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
		const socket = dependencies.connect(endpoint);
		const id = randomUUID();
		let settled = false;
		let response = Buffer.alloc(0);
		const timeout = setTimeout(() => finish(new Error(`Herdr ${label} timed out`)), 2_000);
		function finish(error?: Error, result?: Record<string, unknown>): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			if (error) reject(error);
			else resolve(result!);
		}
		socket.on("error", () => finish(new Error("Herdr socket failed")));
		socket.on("end", () => finish(new Error("Herdr response ended early")));
		socket.on("close", () => finish(new Error("Herdr socket closed early")));
		socket.on("connect", () => {
			if (settled) return;
			try {
				socket.write(`${JSON.stringify({ id, method, params })}\n`);
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
				finish(undefined, message.result);
			} catch {
				finish(new Error(`Herdr ${label} rejected`));
			}
		});
	});
}

// The CLI treats `--` as label text; socket JSON preserves even option-shaped names.
export function renameHerdrPane(
	paneId: string,
	socketPath: string,
	name: string | undefined,
	dependencies: HerdrTransportDependencies = defaultTransport,
): Promise<void> {
	const params = { pane_id: paneId, label: name ?? null };
	return request(socketPath, "pane.rename", params, "rename", dependencies).then(() => undefined);
}

// `pane.get` replies with `{type: "pane_info", pane}`; an unlabeled pane omits `label`.
export function readHerdrPaneLabel(
	paneId: string,
	socketPath: string,
	dependencies: HerdrTransportDependencies = defaultTransport,
): Promise<string | undefined> {
	return request(socketPath, "pane.get", { pane_id: paneId }, "read", dependencies).then((result) => {
		const pane = result.pane;
		if (!pane || typeof pane !== "object" || Array.isArray(pane)) throw new Error("Invalid Herdr response");
		const label = (pane as { label?: unknown }).label;
		if (label === null || label === undefined) return undefined;
		if (typeof label !== "string") throw new Error("Invalid Herdr response");
		return label;
	});
}
