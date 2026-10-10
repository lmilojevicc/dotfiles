/** Component contract: native offsets are converted to UTF-16 before this seam. */
export type Detector = "email" | "phone" | "apiToken" | "privateKey" | "credentialUrl";
export interface RedactionMatch {
  start: number;
  end: number;
  replacement: string;
  kind: "literal" | Detector;
}
export interface RedactionResult {
  text: string;
  matches: RedactionMatch[];
}
export interface Redactor {
  redact(text: string): RedactionResult;
  /** Optional text-only scan with identical safety, reservation and resource guarantees. */
  redactText?(text: string): string;
  reset(): void;
}
export interface NativeConfig {
  literals: Record<string, string>;
  detectors: Record<Detector, boolean>;
}
export interface ExtensionConfig extends NativeConfig {
  sources: {
    toolResults: boolean;
    userMessages: boolean;
    systemPrompt: boolean;
  };
}
export interface FileReadInput { path: string; offset?: number; limit?: number }
export interface FileEditInput { path: string; oldText: string; newText: string }
export interface FileEditManyInput { path: string; edits: Array<{ oldText: string; newText: string }> }
export interface FileWriteInput { path: string; content: string }
export interface FileResult { text: string; path: string }
export interface FileSession {
  read(input: FileReadInput): Promise<FileResult>;
  edit(input: FileEditInput): Promise<FileResult>;
  editMany(input: FileEditManyInput): Promise<FileResult>;
  write(input: FileWriteInput): Promise<FileResult>;
  /** Register a path actually observed by a trusted local tool, not model-supplied aliases. */
  rememberPath(path: string): Promise<string>;
  reset(): void;
}
export interface FileSessionOptions {
  cwd: string;
  redactor: Redactor;
  protectedPaths?: readonly string[];
  /** Original -> alias dictionary, used only to resolve local file paths safely. */
  literalMappings?: Readonly<Record<string, string>>;
}
