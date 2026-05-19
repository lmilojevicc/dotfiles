import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "keep-awake";
const STATE_SYMBOL = Symbol.for("milo.pi.keep-awake.state");
const WINDOWS_EXECUTION_STATE_SCRIPT = String.raw`
$code = @"
using System;
using System.Runtime.InteropServices;
public static class PiKeepAwake {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
Add-Type -TypeDefinition $code
$flags = [uint32]0x80000001 # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
[PiKeepAwake]::SetThreadExecutionState($flags) | Out-Null
try {
  while ($true) {
    Start-Sleep -Seconds 60
    [PiKeepAwake]::SetThreadExecutionState($flags) | Out-Null
  }
} finally {
  [PiKeepAwake]::SetThreadExecutionState([uint32]0x80000000) | Out-Null # ES_CONTINUOUS clears requirement
}
`;

type KeepAwakeBackend = {
	name: string;
	label: string;
	command: string;
	args: string[];
	options?: SpawnOptionsWithoutStdio;
};

type KeepAwakeState = {
	process?: ChildProcess;
	backendLabel?: string;
	exitHandlerInstalled?: boolean;
};

function state(): KeepAwakeState {
	const host = globalThis as unknown as Record<PropertyKey, KeepAwakeState | undefined>;
	host[STATE_SYMBOL] ??= {};
	return host[STATE_SYMBOL];
}

function processIsRunning(process: ChildProcess | undefined): boolean {
	return Boolean(process && process.exitCode === null && !process.killed);
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.notify(message, type);
	} catch {
		// The UI context can become stale during reload/shutdown.
	}
}

function setAwakeStatus(ctx: ExtensionContext, enabled: boolean, backendLabel = state().backendLabel) {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setStatus(STATUS_KEY, enabled ? `☕ awake${backendLabel ? `:${backendLabel}` : ""}` : undefined);
	} catch {
		// The UI context can become stale during reload/shutdown.
	}
}

function canExecute(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveCommand(command: string): string | undefined {
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
		return canExecute(command) ? command : undefined;
	}

	const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	const extensions =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1")
					.split(";")
					.filter(Boolean)
			: [""];
	const names = process.platform === "win32" && /\.[a-z0-9]+$/i.test(command)
		? [command]
		: extensions.map((extension) => `${command}${extension}`);

	for (const dir of pathEntries) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (canExecute(candidate)) return candidate;
		}
	}

	return undefined;
}

function isWsl(): boolean {
	if (process.platform !== "linux") return false;
	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8"));
	} catch {
		return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
	}
}

function macosBackend(): KeepAwakeBackend | undefined {
	const command = resolveCommand("/usr/bin/caffeinate") ?? resolveCommand("caffeinate");
	if (!command) return undefined;
	return { name: "caffeinate", label: "macOS", command, args: ["-i"] };
}

function longRunningShellArgs(): string[] {
	return ["sh", "-c", "while :; do sleep 3600; done"];
}

function systemdInhibitBackend(): KeepAwakeBackend | undefined {
	const command = resolveCommand("systemd-inhibit");
	if (!command) return undefined;
	return {
		name: "systemd-inhibit",
		label: "systemd",
		command,
		args: [
			"--what=sleep:idle",
			"--who=pi",
			"--why=Pi agent running",
			"--mode=block",
			...longRunningShellArgs(),
		],
	};
}

function gnomeSessionInhibitBackend(): KeepAwakeBackend | undefined {
	const command = resolveCommand("gnome-session-inhibit");
	if (!command) return undefined;
	return {
		name: "gnome-session-inhibit",
		label: "GNOME",
		command,
		args: [
			"--inhibit",
			"suspend",
			"--inhibit",
			"idle",
			"--reason",
			"Pi agent running",
			...longRunningShellArgs(),
		],
	};
}

function windowsBackend(): KeepAwakeBackend | undefined {
	const command = resolveCommand("powershell.exe") ?? resolveCommand("powershell") ?? resolveCommand("pwsh.exe");
	if (!command) return undefined;
	const isWindowsPowerShell = /powershell(?:\.exe)?$/i.test(command);
	return {
		name: "set-thread-execution-state",
		label: process.platform === "linux" ? "Windows/WSL" : "Windows",
		command,
		args: [
			"-NoProfile",
			...(isWindowsPowerShell ? ["-ExecutionPolicy", "Bypass"] : []),
			"-Command",
			WINDOWS_EXECUTION_STATE_SCRIPT,
		],
		options: { windowsHide: true },
	};
}

function selectBackend(): KeepAwakeBackend | undefined {
	if (process.platform === "darwin") return macosBackend();
	if (process.platform === "win32") return windowsBackend();
	if (process.platform === "linux") {
		// WSL cannot reliably inhibit the Windows host from inside Linux, so prefer a Windows process when available.
		if (isWsl()) return windowsBackend() ?? systemdInhibitBackend() ?? gnomeSessionInhibitBackend();
		return systemdInhibitBackend() ?? gnomeSessionInhibitBackend();
	}
	return undefined;
}

function unsupportedMessage(): string {
	if (process.platform === "linux") {
		return "keep-awake: no Linux inhibitor found; install systemd-inhibit or gnome-session-inhibit";
	}
	if (process.platform === "win32") {
		return "keep-awake: PowerShell not found; cannot call SetThreadExecutionState";
	}
	return `keep-awake: unsupported platform ${process.platform}`;
}

function stopKeepAwake() {
	const current = state().process;
	state().process = undefined;
	state().backendLabel = undefined;
	if (!current) return;
	if (processIsRunning(current)) current.kill("SIGTERM");
}

function installExitHandler() {
	const currentState = state();
	if (currentState.exitHandlerInstalled) return;
	currentState.exitHandlerInstalled = true;
	process.once("exit", stopKeepAwake);
}

function startKeepAwake(ctx: ExtensionContext) {
	const currentState = state();
	if (processIsRunning(currentState.process)) {
		setAwakeStatus(ctx, true);
		return;
	}

	const backend = selectBackend();
	if (!backend) {
		notify(ctx, unsupportedMessage(), "warning");
		setAwakeStatus(ctx, false);
		return;
	}

	const child = spawn(backend.command, backend.args, { stdio: "ignore", ...backend.options });
	currentState.process = child;
	currentState.backendLabel = backend.label;
	installExitHandler();

	child.once("error", (error) => {
		if (state().process === child) {
			state().process = undefined;
			state().backendLabel = undefined;
		}
		notify(ctx, `keep-awake failed (${backend.name}): ${error.message}`, "error");
		setAwakeStatus(ctx, false);
	});

	child.once("exit", () => {
		if (state().process === child) {
			state().process = undefined;
			state().backendLabel = undefined;
		}
		setAwakeStatus(ctx, false);
	});

	child.unref();
	setAwakeStatus(ctx, true, backend.label);
}

export default function keepAwake(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		startKeepAwake(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopKeepAwake();
		setAwakeStatus(ctx, false);
	});
}
