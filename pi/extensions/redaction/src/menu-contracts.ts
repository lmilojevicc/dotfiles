import type { ExtensionConfig } from "./contracts.ts";

/** Local-only object; never emit revisions or configuration into session/model data. */
export interface PrivateConfigSnapshot {
  readonly path: string;
  readonly config: ExtensionConfig;
  /** Opaque optimistic-concurrency token, including absent-file state. */
  readonly revision: string;
  /** Save crossed its commit point; subsequent durability/owned-cleanup issue only. */
  readonly warnings?: readonly ("durability" | "cleanup")[];
}
export interface PrivateConfigStore {
  /** Read safely without creating files/directories. Missing means all-off defaults. */
  read(): Promise<PrivateConfigSnapshot>;
  /** Explicit human save only. Refuse stale revisions; persist atomically and privately. */
  save(expected: PrivateConfigSnapshot, draft: ExtensionConfig): Promise<PrivateConfigSnapshot>;
}
export type ConfigStoreErrorCode = "invalid" | "unsafe" | "conflict" | "busy" | "io";
export type MenuSection = "sources" | "detectors" | "replacements";
