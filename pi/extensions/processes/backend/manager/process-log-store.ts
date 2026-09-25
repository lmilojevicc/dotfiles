// Source: @aliou/pi-processes 0.12.0; local compatibility patches: ../UPSTREAM.md.
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trimIncompleteUtf8Suffix } from "../utils/buffer.ts";
import type { ProcessLogPaths } from "./internal-types.ts";
import { MAX_LOG_FILE_BYTES, MAX_TAIL_READ_BYTES } from "./limits.ts";

const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_FULL_FILE_BYTES = MAX_TAIL_READ_BYTES * 8;
const TAIL_TRUNCATION_PREFIX = "[… truncated] ";
const STDOUT_TRUNCATION_MARKER =
  "[retained log rotated]\n";
const STDERR_TRUNCATION_MARKER =
  "[retained log rotated]\n";

/**
 * Stores process log files on disk and enforces a per-file size cap.
 *
 * The log directory is created lazily: constructing a store without an
 * explicit `logDir` does not touch the filesystem, so a session that never
 * starts a process leaves no temp directory behind. An explicit `logDir` is a
 * caller-owned parent; only a private child directory is created/removed.
 *
 * Each file holds a single window of history. When a file exceeds
 * {@link MAX_LOG_FILE_BYTES} it is truncated to zero and writing restarts
 * from a marker line, so `stdout.log`, `stderr.log`, and `combined.log` can
 * hold different windows of history after a breach. Local `combined.log`
 * retains sanitized chunks, not tagged/truncated event lines; the public raw
 * stdout/stderr paths can contain secrets and terminal controls.
 */
export class ProcessLogStore {
  private logDir: string | null = null;
  private readonly explicitLogDir: string | undefined;
  private readonly maxFileBytes: number;
  private readonly fileBytes = new Map<string, number>();
  private readonly rotatedFiles = new Set<string>();

  isRotated(file: string): boolean { return this.rotatedFiles.has(file); }
  fileSize(file: string): number { return statSync(file).size; }

  constructor(logDir?: string, options?: { maxFileBytes?: number }) {
    this.explicitLogDir = logDir;
    this.maxFileBytes = options?.maxFileBytes ?? MAX_LOG_FILE_BYTES;
  }

  private ensureLogDir(): string {
    if (this.logDir) return this.logDir;
    // An explicit directory is a parent, never cleanup authority over caller data.
    this.logDir = mkdtempSync(join(this.explicitLogDir ?? tmpdir(), "pi-processes-"));
    return this.logDir;
  }

  getLogDir(): string {
    return this.ensureLogDir();
  }

  createLogs(processId: string): ProcessLogPaths {
    const dir = this.ensureLogDir();
    const stdoutFile = join(dir, `${processId}-stdout.log`);
    const stderrFile = join(dir, `${processId}-stderr.log`);
    const combinedFile = join(dir, `${processId}-combined.log`);

    const created: string[] = [];
    try {
      for (const file of [stdoutFile, stderrFile, combinedFile]) {
        writeFileSync(file, "", { flag: "wx", mode: 0o600 });
        created.push(file);
        this.fileBytes.set(file, 0);
      }
    } catch (error) {
      for (const file of created) rmSync(file, { force: true });
      throw error;
    }

    return { stdoutFile, stderrFile, combinedFile };
  }

  appendStdout(file: string, data: Buffer): void {
    this.appendCapped(file, data, STDOUT_TRUNCATION_MARKER);
  }

  appendStderr(file: string, data: Buffer): void {
    this.appendCapped(file, data, STDERR_TRUNCATION_MARKER);
  }

  // Local combined view keeps sanitized chunks (including unterminated tails).
  appendCombinedChunk(file: string, data: string): void {
    this.appendCapped(file, data, STDOUT_TRUNCATION_MARKER);
  }

  appendErrorLine(file: string, message: string): void {
    this.appendCapped(file, `${message}\n`, STDERR_TRUNCATION_MARKER);
  }

  readTailLines(filePath: string, lines: number): string[] {
    if (lines <= 0) return [];

    let fd: number | undefined;
    try {
      fd = openSync(filePath, "r");
      const size = fstatSync(fd).size;
      if (size === 0) return [];

      const buffer = Buffer.allocUnsafe(Math.min(size, MAX_TAIL_READ_BYTES));
      let bufferStart = buffer.length;
      let position = size;
      let bytesRead = 0;
      let newlineCount = 0;

      while (
        position > 0 &&
        bytesRead < MAX_TAIL_READ_BYTES &&
        newlineCount <= lines
      ) {
        const length = Math.min(
          TAIL_CHUNK_BYTES,
          position,
          MAX_TAIL_READ_BYTES - bytesRead,
        );
        position -= length;
        bufferStart -= length;
        readExact(fd, buffer, bufferStart, length, position);
        bytesRead += length;
        newlineCount += countNewlines(
          buffer.subarray(bufferStart, bufferStart + length),
        );
      }

      let populated: Buffer<ArrayBufferLike> = buffer.subarray(bufferStart);
      const startedMidFile = position > 0;
      let partialFirstLine: Buffer | undefined;
      if (startedMidFile) {
        const firstNewline = populated.indexOf(0x0a);
        if (firstNewline === -1) {
          populated = alignUtf8Start(populated);
          const suffix = decodeUtf8Bounded(populated, MAX_TAIL_READ_BYTES);
          return [`${TAIL_TRUNCATION_PREFIX}${suffix}`];
        }
        // The read began in the middle of a logical line. Dropping through
        // its newline also removes any partial UTF-8 code point at the start.
        const partial = alignUtf8Start(populated.subarray(0, firstNewline));
        if (partial.length > 0) {
          partialFirstLine = partial;
        }
        populated = populated.subarray(firstNewline + 1);
      }

      const rawLines = tailLineBuffersNewestFirst(populated, lines);
      if (partialFirstLine && rawLines.length < lines) {
        rawLines.push(partialFirstLine);
      }

      const decodedNewestFirst: string[] = [];
      let remainingBytes = MAX_TAIL_READ_BYTES;
      for (
        let index = 0;
        index < rawLines.length && remainingBytes > 0;
        index++
      ) {
        const rawLine = rawLines[index];
        const decoded = decodeUtf8Bounded(rawLine, remainingBytes);
        const marked =
          partialFirstLine && rawLine === partialFirstLine
            ? `${TAIL_TRUNCATION_PREFIX}${decoded}`
            : decoded;
        decodedNewestFirst.push(marked);
        remainingBytes -= Buffer.byteLength(decoded);
      }
      return decodedNewestFirst.reverse();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  readFullFile(filePath: string): string {
    const size = statSync(filePath).size;
    if (size > MAX_FULL_FILE_BYTES) {
      const marker = `[… truncated, see ${filePath}]\n`;
      return marker + this.readFileSuffix(filePath, MAX_FULL_FILE_BYTES - Buffer.byteLength(marker));
    }
    return readFileSync(filePath, "utf-8");
  }

  getFileSize(paths: ProcessLogPaths): { stdout: number; stderr: number } {
    return { stdout: statSync(paths.stdoutFile).size, stderr: statSync(paths.stderrFile).size };
  }

  removeLogs(paths: ProcessLogPaths): void {
    for (const file of [paths.stdoutFile, paths.stderrFile, paths.combinedFile]) {
      rmSync(file, { force: true });
      this.fileBytes.delete(file);
      this.rotatedFiles.delete(file);
    }
  }

  cleanup(): void {
    if (!this.logDir) return;
    rmSync(this.logDir, { recursive: true, force: true });
    this.logDir = null;
    this.fileBytes.clear();
    this.rotatedFiles.clear();
  }

  [Symbol.dispose](): void {
    this.cleanup();
  }

  /** Truncate-and-restart, bounding even one oversized chunk including marker. */
  private appendCapped(file: string, data: string | Buffer, marker: string): void {
    let bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!bytes.length) return;
    const current = this.fileBytes.get(file) ?? 0;
    if (current + bytes.length > this.maxFileBytes) {
      // Small test/custom caps may not fit a useful marker; rotation is tracked
      // independently, never inferred from user-controlled log text.
      const prefix = Buffer.byteLength(marker) < this.maxFileBytes ? Buffer.from(marker) : Buffer.alloc(0);
      bytes = alignUtf8Start(bytes.subarray(Math.max(0, bytes.length - (this.maxFileBytes - prefix.length))));
      truncateSync(file, 0);
      this.rotatedFiles.add(file);
      this.fileBytes.set(file, 0);
      this.appendExisting(file, prefix);
      this.fileBytes.set(file, prefix.length);
    }
    this.appendExisting(file, bytes);
    this.fileBytes.set(file, (this.fileBytes.get(file) ?? 0) + bytes.length);
  }

  private appendExisting(file: string, bytes: Buffer): void {
    // Never recreate a vanished log with permissive defaults or silently lose
    // earlier data. Fail the asynchronous writer into a retained warning.
    const fd = openSync(file, "r+");
    try {
      const size = fstatSync(fd).size;
      if (size !== (this.fileBytes.get(file) ?? 0)) throw new Error("Retained log size changed outside the manager");
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, size + written);
    } finally { closeSync(fd); }
  }

  private readFileSuffix(filePath: string, maxBytes: number): string {
    let fd: number | undefined;
    try {
      fd = openSync(filePath, "r");
      const size = fstatSync(fd).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.allocUnsafe(length);
      readExact(fd, buffer, 0, length, size - length);
      return decodeUtf8Bounded(alignUtf8Start(buffer), maxBytes);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) count++;
  }
  return count;
}

function alignUtf8Start(buffer: Buffer): Buffer {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}

function readExact(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): void {
  let total = 0;
  while (total < length) {
    const count = readSync(
      fd,
      buffer,
      offset + total,
      length - total,
      position + total,
    );
    if (count === 0) throw new Error("Unexpected end of log file");
    total += count;
  }
}

function tailLineBuffersNewestFirst(buffer: Buffer, count: number): Buffer[] {
  if (buffer.length === 0 || count <= 0) return [];

  const result: Buffer[] = [];
  let end = buffer.length;
  if (buffer[end - 1] === 0x0a) end--;

  while (result.length < count && end >= 0) {
    const newline = end > 0 ? buffer.lastIndexOf(0x0a, end - 1) : -1;
    const start = newline + 1;
    let lineEnd = end;
    if (lineEnd > start && buffer[lineEnd - 1] === 0x0d) lineEnd--;
    result.push(buffer.subarray(start, lineEnd));
    if (newline === -1) break;
    end = newline;
  }

  return result;
}

function decodeUtf8Bounded(buffer: Buffer, maxOutputBytes: number): string {
  if (buffer.length === 0 || maxOutputBytes <= 0) return "";

  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  let remaining = maxOutputBytes;

  for (let offset = 0; offset < buffer.length && remaining > 0; ) {
    const end = Math.min(buffer.length, offset + TAIL_CHUNK_BYTES);
    const text = decoder.decode(buffer.subarray(offset, end), {
      stream: end < buffer.length,
    });
    const textBytes = Buffer.byteLength(text);
    if (textBytes <= remaining) {
      parts.push(text);
      remaining -= textBytes;
    } else {
      const prefix = trimIncompleteUtf8Suffix(
        Buffer.from(text).subarray(0, remaining),
      );
      parts.push(prefix.toString("utf-8"));
      remaining = 0;
    }
    offset = end;
  }

  return parts.join("");
}
