// Vendored from @ff-labs/pi-fff 0.11.0 (MIT, https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff).
// Changed: OpenCode runs on Bun, so this loads @ff-labs/fff-bun directly instead of choosing an SDK at runtime.

import type { FileFinderApi, InitOptions, Result } from "@ff-labs/fff-bun";
import { FileFinder } from "@ff-labs/fff-bun";

/** waitForScan() also resolves on timeout, so this bounds startup rather than guaranteeing a full index. */
export const SCAN_TIMEOUT_MS = 15_000;

export interface PickerOptions {
  basePath: string;
  enableHomeDirScanning?: boolean;
  enableFsRootScanning?: boolean;
  followSymlinks?: boolean;
}

/** Opens every picker in this process — the workspace picker and the aux pickers — on the same databases. */
export class FilePickerFactory {
  private dbDisabled = false;
  private readonly frecencyDbPath: string;
  private readonly historyDbPath: string;
  private readonly onDbFailure?: (error: string) => void;

  constructor(opts: {
    frecencyDbPath: string;
    historyDbPath: string;
    onDbFailure?: (error: string) => void;
  }) {
    this.frecencyDbPath = opts.frecencyDbPath;
    this.historyDbPath = opts.historyDbPath;
    this.onDbFailure = opts.onDbFailure;
  }

  /** True once the databases were given up on, so pickers open without them. */
  get databasesDisabled(): boolean {
    return this.dbDisabled;
  }

  /** Opens a scanned, ready-to-use picker. Throws if it cannot be created. */
  async create(options: PickerOptions): Promise<FileFinderApi> {
    const result = this.openWithDbFallback(options);
    if (!result.ok) {
      throw new Error(`Failed to create FFF file picker for ${options.basePath}: ${result.error}`);
    }
    await result.value.waitForScan(SCAN_TIMEOUT_MS);
    return result.value;
  }

  private openWithDbFallback(options: PickerOptions): Result<FileFinderApi> {
    const init: InitOptions = { ...options, aiMode: true };
    if (this.dbDisabled) return FileFinder.create(init);

    const result = FileFinder.create({
      ...init,
      frecencyDbPath: this.frecencyDbPath,
      historyDbPath: this.historyDbPath,
    });
    if (result.ok) return result;

    // Usually transient (broken lock, corruption): drop the databases rather than having no picker.
    const dbLess = FileFinder.create(init);
    if (!dbLess.ok) return result;
    this.dbDisabled = true;
    this.onDbFailure?.(result.error);
    return dbLess;
  }
}
