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

/** POSIX shell quoting for the command text accepted by terminal host launch commands. */
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function buildPiCommand(
  sessionPath: string,
  bootstrapPath: string,
  runtimeState?: ForkRuntimeState,
): string {
  const args = ["exec", quoteShellArg("pi"), quoteShellArg("--session"), quoteShellArg(sessionPath), quoteShellArg("--extension"), quoteShellArg(bootstrapPath)];
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
