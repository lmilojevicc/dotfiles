import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ForkRuntimeState } from "./session.ts";

export type ForkPlacement = "horizontal" | "vertical" | "tab";
export type HostKind = "tmux" | "herdr";

export interface HostValidationResult {
  ok: boolean;
  error?: string;
}

export interface HostLaunchRequest {
  placement: ForkPlacement;
  cwd: string;
  sessionPath: string;
  sessionId: string;
  bootstrapPath: string;
  handoffPath: string;
  handoffNonce: string;
  runtimeState?: ForkRuntimeState;
}

export interface HostLaunchResult {
  ok: boolean;
  paneId?: string;
  error?: string;
  cleanupError?: string;
}

export interface HostAdapter {
  readonly kind: HostKind;
  validateSource(): HostValidationResult;
  launch(request: HostLaunchRequest): Promise<HostLaunchResult>;
}

/** An executable plus the leading arguments that run this Pi installation. */
export interface PiLauncher {
  command: string;
  prefixArgs: string[];
}

const SCRIPT_PATH = /\.(?:c|m)?[jt]s$/i;
const INTERPRETER = /^(?:node|nodejs|bun|deno)(?:\.exe)?$/i;

/**
 * Terminal hosts launch the child from their own environment: tmux runs the created command under
 * the tmux server's PATH, and Herdr types it into a fresh shell. A bare `pi` therefore resolves to
 * whatever that PATH holds, which may differ from (or omit) the installation running this process.
 * Deriving the launcher from the running process pins the child to the same installation.
 */
export function resolvePiLauncher(
  execPath: string = process.execPath,
  argv: readonly string[] = process.argv,
  fileExists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
  realpath: (path: string) => string = realpathSync,
): PiLauncher | undefined {
  // The managed `pi` wrapper exports its install root and puts the installer's node on PATH for the
  // child; launching the same wrapper keeps both, where node + cli.js would bypass them.
  const managedRoot = env.PI_MANAGED_INSTALL_ROOT;
  if (managedRoot && isAbsolute(managedRoot)) {
    const wrapper = join(dirname(managedRoot), "bin", "pi");
    if (fileExists(wrapper)) return { command: wrapper, prefixArgs: [] };
  }
  const script = argv[1];
  if (script && isAbsolute(script) && fileExists(script)) {
    // npm installs run Pi through an extensionless `.bin/pi` symlink to the bundled cli.js.
    let target = script;
    try {
      target = realpath(script);
    } catch {}
    if (SCRIPT_PATH.test(target)) return { command: execPath, prefixArgs: [target] };
  }
  // A compiled Pi binary is its own launcher; a bare interpreter alone identifies nothing.
  if (!INTERPRETER.test(basename(execPath)) && isAbsolute(execPath) && fileExists(execPath)) {
    return { command: execPath, prefixArgs: [] };
  }
  return undefined;
}

/** POSIX shell quoting for the command text accepted by terminal host launch commands. */
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function buildPiCommand(
  sessionPath: string,
  bootstrapPath: string,
  runtimeState?: ForkRuntimeState,
  launcher: PiLauncher | undefined = resolvePiLauncher(),
): string {
  const executable = launcher ? [launcher.command, ...launcher.prefixArgs] : ["pi"];
  const args = ["exec", ...executable.map(quoteShellArg), quoteShellArg("--session"), quoteShellArg(sessionPath), quoteShellArg("--extension"), quoteShellArg(bootstrapPath)];
  if (runtimeState?.model) {
    args.push(
      quoteShellArg("--provider"),
      quoteShellArg(runtimeState.model.provider),
      quoteShellArg("--model"),
      quoteShellArg(runtimeState.model.modelId),
    );
  }
  if (runtimeState?.thinkingLevel) {
    args.push(quoteShellArg("--thinking"), quoteShellArg(runtimeState.thinkingLevel));
  }
  return args.join(" ");
}
