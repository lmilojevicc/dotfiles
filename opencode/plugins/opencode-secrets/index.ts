/**
 * opencode-secrets — a pi-secrets-parity secret firewall for OpenCode (v2).
 *
 * Keeps real credentials out of the model's context and out of session files.
 * Pipeline per string (mirrors pi-secrets at-rest.ts scrubString):
 *
 *   fold dump views -> capture/evict -> obfuscate -> mask sub-floor spans
 *
 * - Registered values (registry file, envScan, learned file) are replaced with
 *   reversible $$[LABEL_]12CHARS$$ placeholders in user prompts, outgoing model
 *   messages (including assistant replay thinking and tool arguments), and tool
 *   results — including error-path results and dump-style views (od -c, xxd,
 *   bare hex rows, char-code-per-line, base64 runs).
 * - Placeholders are restored to real values in tool inputs right before
 *   execution (non-read tools only), so edits and shell commands still work on
 *   real bytes.
 * - Replace-mode registry entries are one-way: same-length deterministic
 *   scrambled text, never restorable.
 * - Learn-on-first-sight: credential-named assignments, URL passwords, and
 *   vendor-prefixed tokens whose value passes the pi value gate are captured
 *   with self-documenting labels (SLACKTOKEN, AWSACCESSKEY, GITHUBTOKEN, ...)
 *   and persisted to a 0600 learned file so placeholders in resumed sessions
 *   still restore. Delete the learned file (or a key) to forget.
 * - evictContradicted: when later text shows a credential-named variable
 *   holding an obviously code-shaped value (process.env.FOO, JS literal,
 *   punctuated code), a previously auto-captured value is un-learned.
 *   Registry values are never evicted; learned values are (and are removed
 *   from the learned file).
 * - The placeholder key's own content is registered as a replace-mode secret,
 *   so tools reading the state directory see scrambled bytes, not the key.
 * - Registry + learned file are hot-reloaded: their mtimes are re-stat'ed
 *   before each scrub batch and the store rebuilds when they changed.
 * - A one-line note that secrets appear as $$...$$ placeholders and are
 *   resolved at tool time is appended idempotently to the outgoing system
 *   prompt (context/compaction/generate hooks).
 *
 * Placeholder format (pi parity): $$[FRIENDLYNAME_]12CHARS$$ where the 12 chars
 * are an A-Z0-9 base32-ish encoding of the first 8 bytes of
 * HMAC-SHA256(key, value). The old 10-hex format is gone: placeholders already
 * written to past session files will no longer restore.
 *
 * Off by default: enable with `plugins: [{ package: "./plugins/opencode-secrets",
 * options: { enabled: true } }]` in opencode.jsonc.
 *
 * Registry (user-maintained, never tracked): ~/.config/opencode/opencode-secrets.json
 * {
 *   "entries": [
 *     { "name": "GITHUB_TOKEN", "value": "ghp_..." },                  // legacy form
 *     { "name": "OPENROUTER_KEY", "env": "OPENROUTER_API_KEY" },       // legacy form
 *     { "friendlyName": "EMAIL_PERSONAL_1", "type": "plain", "content": "...", "mode": "obfuscate" },
 *     { "type": "regex", "content": "chain-internal-[a-z0-9]{24}", "mode": "replace" }
 *   ],
 *   "envScan": { "pattern": "(KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(_|$)", "minLength": 8 }
 * }
 *
 * Startup logs one line with counts and labels only — never values.
 */

import { createHash, createHmac, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Paths, key material, and key loading (pi loaders.ts parity)
// ---------------------------------------------------------------------------

const STATE_DIR = join(homedir(), ".local/share/opencode")
const KEY_FILE = join(STATE_DIR, "opencode-secrets.key")
const LEARNED_FILE = join(STATE_DIR, "opencode-secrets-learned.json")
const DEFAULT_REGISTRY = join(homedir(), ".config/opencode/opencode-secrets.json")

/** Key files minted before v2 are 64 hex chars; keep that format. */
const KEY_RE = /^[0-9a-f]{64}$/

interface FileStamp {
  mtimeMs: number
  size: number
}

function statStamp(path: string): FileStamp | undefined {
  try {
    const st = statSync(path)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return undefined
  }
}

function stampEqual(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  return a?.mtimeMs === b?.mtimeMs && a?.size === b?.size
}

let ephemeralKey: string | undefined

/**
 * Load the placeholder key, minting lazily with an exclusive create so two
 * processes converge on one key. A corrupt existing key is a hard error; an
 * unpersistable key degrades to a process-ephemeral key with a warning
 * (placeholders then change every run).
 */
function loadOrCreateKey(): string {
  const readValid = (): string | undefined => {
    try {
      const value = readFileSync(KEY_FILE, "utf8").trim()
      if (KEY_RE.test(value)) return value
      if (value.length > 0) {
        console.error(
          `[opencode-secrets] FATAL: placeholder key at ${KEY_FILE} exists but is not a 64-hex-char key. ` +
            `Fix or delete the file; refusing to run with a corrupt key because existing placeholders would silently break.`,
        )
        throw new Error(`opencode-secrets: corrupt placeholder key at ${KEY_FILE}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined
      throw error
    }
    return undefined
  }

  const existing = readValid()
  if (existing !== undefined) return existing

  const generated = randomBytes(32).toString("hex")
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(KEY_FILE, generated + "\n", { flag: "wx", mode: 0o600 })
    return generated
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      console.warn(
        `[opencode-secrets] could not persist the placeholder key (${String(error)}); ` +
          `using a process-ephemeral key — placeholders will not restore across runs`,
      )
      ephemeralKey ??= randomBytes(32).toString("hex")
      return ephemeralKey
    }
    // Another process won the create; converge on its key.
    const winner = readValid()
    if (winner !== undefined) return winner
    console.warn(
      `[opencode-secrets] placeholder key file appeared concurrently but is unreadable; ` +
        `using a process-ephemeral key`,
    )
    ephemeralKey ??= randomBytes(32).toString("hex")
    return ephemeralKey
  }
}

const KEY = loadOrCreateKey()

// ---------------------------------------------------------------------------
// Placeholder codec (pi placeholder.ts parity, minus the case suffix)
// ---------------------------------------------------------------------------

const HASH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const HASH_LEN = 12
const MAX_LABEL_LEN = 32

/** Explicit registry/learned values: pi-parity minimum for the registry floor. */
const EXPLICIT_MIN_LEN = 6
/** Implicit captures and regex obfuscation matches: pi MIN_OBFUSCATE_SECRET_LEN. */
const IMPLICIT_MIN_LEN = 8

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 12 chars from an A-Z0-9 alphabet over the first 8 HMAC-SHA256 bytes. */
function hashBase(value: string): string {
  const digest = createHmac("sha256", KEY).update(value).digest()
  let v = 0n
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(digest[i])
  const radix = BigInt(HASH_CHARS.length)
  let tag = ""
  for (let i = 0; i < HASH_LEN; i++) {
    tag += HASH_CHARS[Number(v % radix)]
    v /= radix
  }
  return tag
}

/** Letters/digits only, uppercased — pi sanitizeSecretFriendlyName. */
function sanitizeFriendlyName(name: string | undefined): string | undefined {
  if (!name) return undefined
  const sanitized = name.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, MAX_LABEL_LEN)
  return sanitized.length > 0 ? sanitized : undefined
}

/**
 * Self-learn pollution guard: a builtin pattern matching its own regex source
 * (seen with the PEM variants) must never be persisted to the learned file.
 * Cheap contains-checks only. Registry entries bypass this path entirely.
 * Consequence: values shaped like a PEM block are scrubbed in-session but not
 * auto-persisted across sessions; add a registry entry for that.
 */
export function looksLikeRegexSource(value: string): boolean {
  if (value.includes("\\s\\S")) return true
  if (/\(\?[a-z-]+\)/.test(value)) return true
  return value.startsWith("-----BEGIN") && value.includes("-----END")
}

/** $$[LABEL_]12CHARS$$ — no :U/:L/:C/:M case suffix (dropped deliberately). */
const PLACEHOLDER_RE = /\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{12}\$\$/g

function reset(re: RegExp): void {
  re.lastIndex = 0
}

// ---------------------------------------------------------------------------
// Built-in credential patterns (pi patterns.ts, split per vendor for labels)
// ---------------------------------------------------------------------------

interface CredentialPattern {
  name: string
  source: string
  flags?: string
  literalPrefixes?: readonly string[]
}

const B = "(?<![A-Za-z0-9_-])"
const E = "(?![A-Za-z0-9_-])"

const PEM_PRIVATE_KEY_SOURCE =
  "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----"

const BUILTIN_PATTERNS: readonly CredentialPattern[] = [
  {
    name: "GITHUBTOKEN",
    source: `${B}(?:gh[opusr]_[A-Za-z0-9_*]{36,}|github_pat_[A-Za-z0-9_*]{36,})${E}`,
    literalPrefixes: ["gho_", "ghp_", "ghu_", "ghs_", "ghr_", "github_pat_"],
  },
  { name: "GITLABTOKEN", source: `${B}glpat-[A-Za-z0-9_*-]{20,}${E}`, literalPrefixes: ["glpat-"] },
  { name: "ANTHROPICKEY", source: `${B}sk-ant-[A-Za-z0-9_*-]{36,}${E}`, literalPrefixes: ["sk-ant-"] },
  {
    name: "OPENAIKEY",
    source: `${B}(?:sk-proj-[A-Za-z0-9_*-]{36,}|sk-[A-Za-z0-9_*-]{48,})${E}`,
    literalPrefixes: ["sk-proj-", "sk-"],
  },
  { name: "AWSACCESSKEY", source: `${B}(?:AKIA|ASIA)[A-Z0-9]{16}${E}`, literalPrefixes: ["AKIA", "ASIA"] },
  { name: "GOOGLEAPIKEY", source: `${B}AIza[A-Za-z0-9_-]{30,}${E}`, literalPrefixes: ["AIza"] },
  {
    name: "SLACKTOKEN",
    source: `${B}xox[abprs]-[A-Za-z0-9-]{10,}${E}`,
    literalPrefixes: ["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"],
  },
  { name: "NPMTOKEN", source: `${B}npm_[A-Za-z0-9]{30,}${E}`, literalPrefixes: ["npm_"] },
  {
    name: "STRIPEKEY",
    source: `${B}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}${E}`,
    literalPrefixes: ["sk_live_", "sk_test_", "rk_live_", "rk_test_"],
  },
  { name: "STRIPEWEBHOOKSECRET", source: `${B}whsec_[A-Za-z0-9]{20,}${E}`, literalPrefixes: ["whsec_"] },
  { name: "HUGGINGFACETOKEN", source: `${B}hf_[A-Za-z0-9]{30,}${E}`, literalPrefixes: ["hf_"] },
  {
    name: "SENDGRIDKEY",
    source: `${B}SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}${E}`,
    literalPrefixes: ["SG."],
  },
  {
    name: "JWT",
    source: `${B}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}${E}`,
    literalPrefixes: ["eyJ"],
  },
  {
    name: "BEARERTOKEN",
    source: `(?<=\\bBearer )[A-Za-z0-9._~+/=-]{20,}${E}`,
    flags: "i",
    literalPrefixes: ["Bearer "],
  },
  { name: "PRIVATEKEY", source: PEM_PRIVATE_KEY_SOURCE, literalPrefixes: ["-----BEGIN "] },
  {
    name: "SHOPIFYTOKEN",
    source: `${B}(?:shpat_|shpca_|shppa_)[A-Za-z0-9]{32}${E}`,
    literalPrefixes: ["shpat_", "shpca_", "shppa_"],
  },
  { name: "POSTMANTOKEN", source: `${B}PMAK-[A-Za-z0-9]{24}-[A-Za-z0-9]{34}${E}`, literalPrefixes: ["PMAK-"] },
  { name: "PULUMITOKEN", source: `${B}pul-[A-Za-z0-9]{40}${E}`, literalPrefixes: ["pul-"] },
  { name: "DIGITALOCEANTOKEN", source: `${B}dop_v1_[A-Za-z0-9]{64}${E}`, literalPrefixes: ["dop_v1_"] },
  { name: "GRAFANACLOUDTOKEN", source: `${B}glc_[A-Za-z0-9+/]{32,}${E}`, literalPrefixes: ["glc_"] },
  { name: "TWILIOKEY", source: `${B}SK[A-Fa-f0-9]{32}${E}`, literalPrefixes: ["SK"] },
  { name: "ALIBABAKEYID", source: `${B}LTAI[A-Za-z0-9]{20}${E}`, literalPrefixes: ["LTAI"] },
]

function compileSecretRegex(pattern: string, flags?: string): RegExp {
  let resolvedPattern = pattern
  let resolvedFlags = flags ?? ""
  // Accept /pattern/flags literal form too (pi parity).
  const literalMatch = /^\/((?:[^\\/]|\\.)*)\/([ gimsuy]*)$/.exec(pattern)
  if (literalMatch) {
    resolvedPattern = literalMatch[1]
    resolvedFlags = [...new Set([...resolvedFlags, ...literalMatch[2]])].join("")
  }
  return new RegExp(resolvedPattern, resolvedFlags.includes("g") ? resolvedFlags : `${resolvedFlags}g`)
}

// ---------------------------------------------------------------------------
// Deterministic same-length replacement (pi replacement.ts)
// ---------------------------------------------------------------------------

const REPLACEMENT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const NONMATCHING_REPLACEMENT_CHARS = `${REPLACEMENT_CHARS}!#$%&()*+,-./:;<=>?@[]^_{|}~`
const WHITESPACE_REPLACEMENT_CHARS = " \t"
const REGEX_REMATCH_BACKSCAN = 512

function seedFromString(value: string): bigint {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 16)
  return BigInt(`0x${hex}`)
}

/** Deterministic, same-length scrambled text for one-way replace mode. */
function generateDeterministicReplacement(secret: string): string {
  if (secret.length === 0) return ""
  const hash = seedFromString(secret)
  const chars = secret.length === 1 ? ["Z"] : ["Z", "Z"]
  let h = hash
  for (let i = chars.length; i < secret.length; i++) {
    h = h ^ (BigInt(i + 1) * 0x9e3779b97f4a7c15n)
    const idx = Number((h < 0n ? -h : h) % BigInt(REPLACEMENT_CHARS.length))
    chars.push(REPLACEMENT_CHARS[idx])
  }
  return chars.join("")
}

function ensureDistinctReplacement(replacement: string, secret: string): string {
  if (replacement.length === 0 || replacement !== secret) return replacement
  const alt = replacement[0] === REPLACEMENT_CHARS[0] ? REPLACEMENT_CHARS[1] : REPLACEMENT_CHARS[0]
  return alt + replacement.slice(1)
}

interface RegexMatchContext {
  text: string
  start: number
  end: number
}

function regexRematchesInContext(candidate: string, regex: RegExp, ctx: RegexMatchContext): boolean {
  const probe = ctx.text.slice(0, ctx.start) + candidate + ctx.text.slice(ctx.end)
  const spanStart = ctx.start
  const spanEnd = spanStart + candidate.length
  reset(regex)
  regex.lastIndex = Math.max(0, spanStart - REGEX_REMATCH_BACKSCAN)
  for (let m = regex.exec(probe); m !== null; m = regex.exec(probe)) {
    const matchStart = m.index
    const matchEnd = m.index + m[0].length
    if (matchStart >= spanEnd) break
    if (matchEnd > spanStart) {
      reset(regex)
      return true
    }
    if (m[0].length === 0) regex.lastIndex++
  }
  reset(regex)
  return false
}

function findWhitespaceFallbackReplacement(value: string, regex: RegExp, context: RegexMatchContext) {
  const len = value.length
  const filler = NONMATCHING_REPLACEMENT_CHARS[0]
  for (const ws of WHITESPACE_REPLACEMENT_CHARS) {
    const full = ws.repeat(len)
    if (full !== value && !regexRematchesInContext(full, regex, context)) return full
    for (let pos = 0; pos < len; pos++) {
      const candidate = `${filler.repeat(pos)}${ws}${filler.repeat(len - pos - 1)}`
      if (candidate !== value && !regexRematchesInContext(candidate, regex, context)) return candidate
    }
  }
  return undefined
}

/** Same-length replacement that the regex provably does not re-match. */
function findNonMatchingReplacement(value: string, regex: RegExp, context: RegexMatchContext) {
  const len = value.length
  if (len === 0) return undefined
  const baseline = NONMATCHING_REPLACEMENT_CHARS[0].repeat(len)
  for (let position = 0; position < len; position++) {
    for (const ch of NONMATCHING_REPLACEMENT_CHARS) {
      const candidate = `${baseline.slice(0, position)}${ch}${baseline.slice(position + 1)}`
      if (candidate === value) continue
      if (!regexRematchesInContext(candidate, regex, context)) return candidate
    }
  }
  for (const ch of NONMATCHING_REPLACEMENT_CHARS) {
    const candidate = ch.repeat(len)
    if (candidate === value) continue
    if (!regexRematchesInContext(candidate, regex, context)) return candidate
  }
  return findWhitespaceFallbackReplacement(value, regex, context)
}

function regexHasUnresolvableShortMatchFallback(regex: RegExp): boolean {
  return ([1, 2] as const).some((length) => {
    const probe = "\u0000".repeat(length)
    const saved = regex.lastIndex
    try {
      return findNonMatchingReplacement(probe, regex, { text: probe, start: 0, end: length }) === undefined
    } finally {
      regex.lastIndex = saved
      reset(regex)
    }
  })
}

/** Keyed pseudo-random run for regex replace fallbacks. */
function buildKeyedReplacementRun(key: string, length: number): string {
  if (length <= 0) return ""
  const radix = REPLACEMENT_CHARS.length
  let out = ""
  for (let block = 0; out.length < length; block++) {
    const digest = createHmac("sha256", key).update(`replace-chunk\0${length}\0${block}`).digest()
    for (let i = 0; i < digest.length && out.length < length; i++) {
      out += REPLACEMENT_CHARS[digest[i] % radix]
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Value and name gates (pi value-gate.ts + at-rest.ts name gate)
// ---------------------------------------------------------------------------

export type ValueShape =
  | "vendor-key"
  | "scheme"
  | "iso-datetime"
  | "unix-seconds"
  | "unix-ms"
  | "version"
  | "uuid"
  | "hex-digest"
  | "path"
  | "wordlist"
  | "lowercase-word"
  | "uppercase-word"
  | "digits"
  | "passwordish"
  | "mixed-alnum"
  | "other"
  | "empty"

const GATE_VENDOR_PREFIXES: string[] = BUILTIN_PATTERNS.flatMap((pattern) => pattern.literalPrefixes ?? [])
  .filter((prefix) => prefix !== "SK")
  .map((prefix) => prefix.toLowerCase())

const SCHEME_NAMES = new Set([
  "oauth2-bearer",
  "oauth2",
  "oauth",
  "bearer",
  "basic",
  "digest",
  "jwt",
  "ntlm",
  "negotiate",
  "anonymous",
  "apikey",
  "api-key",
])

const VETO_SHAPES: ReadonlySet<ValueShape> = new Set([
  "empty",
  "scheme",
  "iso-datetime",
  "unix-seconds",
  "unix-ms",
  "version",
  "path",
  "wordlist",
  "lowercase-word",
  "uppercase-word",
  "digits",
])

const PASSWORD_NAME_RE = /(?:PASSWORD|PASSWD|PASS)(?:_|$)/i
const IDENTIFIER_NAME_RE = /(?:^|_)ID$/i
const CREDENTIAL_SYMBOL_RE = /[&!?~%^*+#=@]/

function isIsoDatetime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) ||
    /^\d{4}\d{2}\d{2}T\d{6}Z?$/.test(value)
  )
}

function isPath(value: string): boolean {
  if (/^(?:\/|~\/|\.\/|\.\.\/)/.test(value)) return true
  return (
    value.includes("/") &&
    value.split("/").every((segment) => segment.length > 0 && /^[A-Za-z0-9._-]+$/.test(segment))
  )
}

export function classifyValueShape(value: string): ValueShape {
  if (value.length === 0) return "empty"
  const lower = value.toLowerCase()
  if (GATE_VENDOR_PREFIXES.some((prefix) => lower.startsWith(prefix))) return "vendor-key"
  if (SCHEME_NAMES.has(lower)) return "scheme"
  if (isIsoDatetime(value)) return "iso-datetime"
  if (/^\d{10}$/.test(value)) {
    const n = Number(value)
    if (n > 1_000_000_000 && n < 2_000_000_000) return "unix-seconds"
  }
  if (/^\d{13}$/.test(value)) return "unix-ms"
  if (/^\d+(\.\d+){1,3}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(value)) return "version"
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) return "uuid"
  if (/^[0-9a-fA-F]{24,}$/.test(value)) return "hex-digest"
  if (isPath(value)) return "path"
  if (/^[a-z]+(?:[-_. ][a-z]+){1,}$/.test(value)) return "wordlist"
  if (/^[a-z]{4,32}$/.test(value)) return "lowercase-word"
  if (/^[A-Z]{4,32}$/.test(value)) return "uppercase-word"
  if (/^\d{4,}$/.test(value)) return "digits"
  if (
    value.length >= 8 &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9]/.test(value)
  ) {
    return "passwordish"
  }
  if (/^[A-Za-z0-9_-]{8,}$/.test(value)) return "mixed-alnum"
  return "other"
}

export function valueVetoesRedaction(value: string): boolean {
  return VETO_SHAPES.has(classifyValueShape(value))
}

export function isCredentialLikePassword(value: string): boolean {
  if (value.length < IMPLICIT_MIN_LEN) return false
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) return true
  return CREDENTIAL_SYMBOL_RE.test(value)
}

function isKeyShapedValue(shape: ValueShape, value: string, floor: number): boolean {
  if (shape === "passwordish") return true
  if (shape === "hex-digest") return true
  if (shape === "mixed-alnum") return /[A-Za-z]/.test(value) && value !== value.toUpperCase()
  if (shape === "other") return value.length >= floor && CREDENTIAL_SYMBOL_RE.test(value)
  return false
}

/** pi verdict: "mask" values are learned; "keep" values are left alone. */
export function valueRedactionVerdict(
  name: string,
  value: string,
  floor: number = IMPLICIT_MIN_LEN,
): "keep" | "mask" {
  const shape = classifyValueShape(value)
  if (VETO_SHAPES.has(shape)) return "keep"
  if (shape === "vendor-key") return value.length >= floor ? "mask" : "keep"
  // UUIDs are identifiers, not secrets — unless the name says otherwise.
  if (shape === "uuid") return IDENTIFIER_NAME_RE.test(name) ? "keep" : "mask"
  // PASSWORD-named values are masked at ANY length (span-hashed when short).
  if (PASSWORD_NAME_RE.test(name) && (shape === "passwordish" || shape === "other")) return "mask"
  if (value.length < floor) return "keep"
  if (isKeyShapedValue(shape, value, floor)) return "mask"
  return "keep"
}

/**
 * Credential keyword must sit at a word boundary: underscore or camelCase.
 * `AUTH` must not match "Author".
 */
const SECRET_NAME_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(_|$)/i

export function isSecretName(name: string): boolean {
  const match = SECRET_NAME_RE.exec(name)
  if (match === null) return false
  const i = match.index
  if (i === 0) return true
  const before = name[i - 1]
  if (before === "_") return true
  return /[a-z]/.test(before) && /[A-Z]/.test(match[1][0])
}

// ---------------------------------------------------------------------------
// Assignment / URL scanning primitives (pi at-rest.ts)
// ---------------------------------------------------------------------------

const ASSIGNMENT_NAME_RE = /["']?([A-Za-z_][A-Za-z0-9_]{0,63})["']?\s*(=|:)/g
const VALUE_RE = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s"']{1,}))/
const CONNECTION_URL_RE = /[a-z][a-z0-9+.-]{0,30}:\/\/[^/:@?#\s]*:([^/?#\s]+)@/gi
const TRAILING_PUNCT_RE = /[;,)\]}]+$/
const CODE_VALUE_RE = /[()[\]{}<>|`]/
const DOTTED_REFERENCE_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/
const JS_LITERAL_VALUES = new Set(["undefined", "null", "true", "false", "NaN", "Infinity"])

function refusableValueShape(value: string): boolean {
  return CODE_VALUE_RE.test(value) || DOTTED_REFERENCE_RE.test(value) || JS_LITERAL_VALUES.has(value)
}

const CODE_LINE_RE =
  /=>|\b(?:const|let|var|function|class|interface|type|enum|import|export|return|async|public|private|readonly)\b|\?\.|[;{}]\s*$/
const CODE_MIN_LINES = 3
const CODE_MIN_RATIO = 0.15

function looksLikeCode(text: string): boolean {
  let nonEmpty = 0
  let code = 0
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    nonEmpty++
    if (CODE_LINE_RE.test(line)) code++
  }
  return code >= CODE_MIN_LINES && code / nonEmpty >= CODE_MIN_RATIO
}

const BULLET_CHAR = "\u2022"

function acceptedUnquotedValue(raw: string): string | undefined {
  const value = raw.replace(TRAILING_PUNCT_RE, "")
  if (value.length === 0 || refusableValueShape(value)) return undefined
  return value
}

interface AssignmentCandidate {
  name: string
  value: string
  valueStart: number
  valueEnd: number
  quoted: boolean
}

function assignmentCandidates(text: string): AssignmentCandidate[] {
  const out: AssignmentCandidate[] = []
  const codeShaped = looksLikeCode(text)
  reset(ASSIGNMENT_NAME_RE)
  for (let match = ASSIGNMENT_NAME_RE.exec(text); match !== null; match = ASSIGNMENT_NAME_RE.exec(text)) {
    if (!isSecretName(match[1])) continue
    const operator = match[2]
    const valueMatch = VALUE_RE.exec(text.slice(ASSIGNMENT_NAME_RE.lastIndex))
    if (valueMatch === null) continue
    const raw = valueMatch[1] ?? valueMatch[2] ?? valueMatch[3]
    const quoted = valueMatch[1] !== undefined || valueMatch[2] !== undefined

    if (codeShaped && operator === ":" && !quoted) continue
    if (codeShaped && quoted && (raw.length < 12 || /^[A-Za-z]+$/.test(raw))) continue

    let value = raw
    if (!quoted) {
      const accepted = acceptedUnquotedValue(raw)
      if (accepted === undefined) continue
      value = accepted
    }
    if (value.includes("$$") || value.includes(BULLET_CHAR)) continue

    const valueStart = ASSIGNMENT_NAME_RE.lastIndex + valueMatch.index + valueMatch[0].lastIndexOf(raw)
    out.push({ name: match[1], value, valueStart, valueEnd: valueStart + value.length, quoted })
  }
  return out
}

// ---------------------------------------------------------------------------
// Dump-view folding (pi dump-views.ts, size-capped)
// ---------------------------------------------------------------------------

const FOLD_MAX = 64 * 1024
const FOLD_RUN_MAX = 32 * 1024

const OCTAL_ADDR_RE = /^[0-7]{7,8}(?: {3}|\s{2,})/
const HEXPAIR_RUN_RE = /(?:\b[0-9a-fA-F]{2}\b[ \t]+)+\b[0-9a-fA-F]{2}\b/g
const B64_RUN_RE = /[A-Za-z0-9+/]{16,}={0,2}/g

/**
 * Cheap density probes for dump-view material (xxd / od -c / hex pairs /
 * char-per-line / base64). Checked inside needsDeepScrub so folding — about
 * five full-text passes — only runs on strings the cheap gate already
 * suspects. Thresholds mirror the fold minimums (4+ hex pairs, 16+ base64
 * chars, address-row shapes) so every foldable dump still triggers the gate.
 */
const DUMP_GATE_RE = new RegExp(
  [
    "(?:\\b[0-9a-fA-F]{2}\\b[ \\t]+){3}\\b[0-9a-fA-F]{2}\\b", // 4+ space-separated hex pairs
    "[A-Za-z0-9+/]{16,}", // base64-alphabet run (B64_RUN_RE floor)
    "^[0-9a-fA-F]{7,8}:[ \\t]", // xxd-style address row
    "^[0-7]{7,8}(?: {3}|\\s{2,})", // od -c style octal address row
    "^[ \\t]*\\[[^\\]\\s]\\]", // char-per-line "[x]" row
    "^[ \\t]*\\('[^')]'\\)", // char-per-line "('x')" row
    "ord\\('[^']*'\\)", // char-per-line "ord('x')" row
  ].join("|"),
  "m",
)

type Region = [number, number, string]

function hexPairsToBytes(run: string): string {
  const toks = run.trim().split(/[ \t]+/)
  let out = ""
  for (const t of toks) {
    const n = t.length
    if (n % 2 !== 0) return ""
    for (let i = 0; i < n; i += 2) {
      const b = parseInt(t.slice(i, i + 2), 16)
      if (Number.isNaN(b)) return ""
      out += String.fromCharCode(b)
    }
  }
  return out
}

function odCFoldRegions(text: string): Region[] {
  const out: Region[] = []
  const lines = text.split("\n")
  let offset = 0
  for (let li = 0; li < lines.length; li++) {
    if (OCTAL_ADDR_RE.exec(lines[li]) === null) {
      offset += lines[li].length + 1
      continue
    }
    const regionStart = offset
    let folded = ""
    let lastIdx = li
    for (let k = li; k < lines.length; k++) {
      const a = OCTAL_ADDR_RE.exec(lines[k])
      if (a === null) break
      for (const t of lines[k].slice(a[0].length).split(/\s{2,}/).filter(Boolean)) {
        if (t.length === 1 && t.charCodeAt(0) >= 32 && t.charCodeAt(0) < 127) folded += t
        else if (t === "sp") folded += " "
        else if (t === "\\n") folded += "\n"
        else if (t === "\\t") folded += "\t"
        else if (t === "\\r") folded += "\r"
        else if (t === "\\\\") folded += "\\"
      }
      lastIdx = k
    }
    const seg = `${lines.slice(li, lastIdx + 1).join("\n")}\n`
    let end = regionStart + seg.length - 1
    if (end > text.length) end = text.length
    if (folded.length >= 4) out.push([regionStart, end, folded])
    for (let k = li; k <= lastIdx; k++) offset += lines[k].length + 1
    li = lastIdx
  }
  return out
}

function hexFoldRegions(text: string): Region[] {
  const out: Region[] = []

  reset(HEXPAIR_RUN_RE)
  for (;;) {
    const m = HEXPAIR_RUN_RE.exec(text)
    if (m === null) break
    const bytes = hexPairsToBytes(m[0])
    if (bytes.length >= 4 && /[ -~]/.test(bytes)) out.push([m.index, m.index + m[0].length, bytes])
  }

  function parseXxdRow(line: string): { groups: string; bytes: string } | undefined {
    const head = /^([0-9a-fA-F]{7,8}): (.*)$/.exec(line)
    if (head === null) return undefined
    const rest = head[2]
    const candidates: Array<{ groups: string; ascii: string }> = []
    const grouped = /((?:\b[0-9a-fA-F]{2,4}\b[ \t]+)*\b[0-9a-fA-F]{2,4}\b)[ \t]+([ -~]{1,})$/.exec(rest)
    if (grouped !== null) candidates.push({ groups: grouped[1], ascii: grouped[2].trimEnd() })
    const gap = / {2,}/.exec(rest)
    if (gap !== null) {
      candidates.push({
        groups: rest.slice(0, gap.index).trim(),
        ascii: rest.slice(gap.index).trimStart().trimEnd(),
      })
    }
    for (const c of candidates) {
      const bytes = hexPairsToBytes(c.groups)
      if (bytes.length > 0 && bytes.length === c.ascii.length) return { groups: c.groups, bytes }
    }
    return undefined
  }

  const lines = text.split("\n")
  for (let li = 0; li < lines.length; li++) {
    const first = parseXxdRow(lines[li])
    if (first === undefined) continue
    let bytes = ""
    let lastIdx = li
    for (let k = li; k < lines.length; k++) {
      const mk = parseXxdRow(lines[k])
      if (mk === undefined) break
      const b = mk.bytes
      if (b.length < 4 || !/[ -~]/.test(b)) break
      bytes += b
      lastIdx = k
    }
    if (bytes.length < 4) {
      li = lastIdx
      continue
    }
    let start = 0
    for (let k = 0; k < li; k++) start += lines[k].length + 1
    let end = start
    for (let k = li; k <= lastIdx; k++) end += lines[k].length + 1
    end -= 1
    if (end > text.length) end = text.length
    out.push([start, end, bytes])
    li = lastIdx
  }
  return out
}

function noAddressHexFoldRegions(text: string): Region[] {
  const out: Region[] = []
  const NO_ADDR_LINE = /^((?:\b[0-9a-fA-F]{2}\b[ \t]+)*\b[0-9a-fA-F]{2}\b)\s{2}([ -~]{1,})$/
  const lines = text.split("\n")
  let offset = 0
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const m = NO_ADDR_LINE.exec(line)
    if (m === null) {
      offset += line.length + 1
      continue
    }
    let bytes = hexPairsToBytes(m[1])
    if (bytes.length < 4 || !/[ -~]/.test(bytes)) {
      offset += line.length + 1
      continue
    }
    let end = offset + line.length + 1
    let k = li + 1
    while (k < lines.length) {
      const nk = NO_ADDR_LINE.exec(lines[k])
      if (nk === null) break
      bytes += hexPairsToBytes(nk[1])
      end += lines[k].length + 1
      k += 1
    }
    end -= 1
    out.push([offset, Math.min(end, text.length), bytes])
    offset = end
    li = k - 1
  }
  return out
}

function charLineFoldRegions(text: string): Region[] {
  const out: Region[] = []
  const CHAR_LINE =
    /^\s*(?:\[([^\]\s])\]|\(['"]([^'"])\)|ord\('[^']*'\)\s*=\s*)(?:0x([0-9A-Fa-f]{1,2}))?\s*([0-9A-Fa-f]{1,3})?\s*$/
  const lines = text.split("\n")
  let offset = 0
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const m = CHAR_LINE.exec(line)
    if (m === null) {
      offset += line.length + 1
      continue
    }
    const lit = m[1] ?? m[2]
    const codeStr = m[3] ?? m[4]
    let ch: string
    if (lit !== undefined && codeStr !== undefined) {
      ch = parseInt(codeStr, 16) === lit.charCodeAt(0) ? lit : String.fromCharCode(parseInt(codeStr, 16))
    } else if (lit !== undefined) {
      ch = lit
    } else if (codeStr !== undefined) {
      ch = String.fromCharCode(parseInt(codeStr, 16))
    } else {
      offset += line.length + 1
      continue
    }
    let folded = ch
    let k = li + 1
    let end = offset + line.length + 1
    while (k < lines.length) {
      const nk = CHAR_LINE.exec(lines[k])
      if (nk === null) break
      const l2 = nk[1] ?? nk[2]
      const c2 = nk[3] ?? nk[4]
      if (l2 !== undefined && c2 !== undefined) {
        folded += parseInt(c2, 16) === l2.charCodeAt(0) ? l2 : String.fromCharCode(parseInt(c2, 16))
      } else if (l2 !== undefined) folded += l2
      else if (c2 !== undefined) folded += String.fromCharCode(parseInt(c2, 16))
      else break
      end += lines[k].length + 1
      k += 1
    }
    end -= 1
    if (folded.length >= 4) out.push([offset, Math.min(end, text.length), folded])
    offset = end
    li = k - 1
  }
  return out
}

function b64Regions(text: string): Region[] {
  const out: Region[] = []
  reset(B64_RUN_RE)
  for (;;) {
    const m = B64_RUN_RE.exec(text)
    if (m === null) break
    if (m[0].length > FOLD_RUN_MAX) continue
    let decoded = ""
    try {
      decoded = Buffer.from(m[0].trim(), "base64").toString("utf8")
    } catch {
      continue
    }
    if (decoded.length >= 8) out.push([m.index, m.index + m[0].length, decoded])
  }
  return out
}

function redactFoldedRegions(store: SecretStore, text: string, regions: Region[]): string {
  if (regions.length === 0) return text
  const sorted = regions.slice().sort((a, b) => a[0] - b[0])
  let out = text
  let shift = 0
  let lastEnd = 0
  for (const [start, end, folded] of sorted) {
    if (start < lastEnd) continue
    const s = start + shift
    const e = end + shift
    if (s < 0 || e > out.length) continue
    captureUnregistered(store, folded, { skipValueVeto: true })
    const hashed = store.obfuscate(folded)
    if (hashed !== folded) {
      out = out.slice(0, s) + hashed + out.slice(e)
      shift += hashed.length - (end - start)
    }
    lastEnd = end
  }
  return out
}

/** od -c / xxd / hexdump / char-per-line / base64 views, folded and scrubbed. */
function foldDumpViews(store: SecretStore, text: string): string {
  if (text.length === 0 || text.length > FOLD_MAX) return text
  let out = redactFoldedRegions(store, text, odCFoldRegions(text))
  out = redactFoldedRegions(store, out, hexFoldRegions(out))
  out = redactFoldedRegions(store, out, noAddressHexFoldRegions(out))
  out = redactFoldedRegions(store, out, charLineFoldRegions(out))
  out = redactFoldedRegions(store, out, b64Regions(out))
  return out
}

// ---------------------------------------------------------------------------
// Registry and learned persistence
// ---------------------------------------------------------------------------

interface RegistryEntry {
  name?: unknown
  friendlyName?: unknown
  type?: unknown
  content?: unknown
  value?: unknown
  env?: unknown
  mode?: unknown
  replacement?: unknown
  flags?: unknown
}

interface CompiledRegistryEntry {
  type: "plain" | "regex"
  content: string
  mode: "obfuscate" | "replace"
  replacement?: string
  flags?: string
  friendlyName?: string
  builtin?: boolean
}

interface EnvScanConfig {
  pattern: string
  minLength: number
}

const DEFAULT_ENV_SCAN: EnvScanConfig = {
  pattern: "(KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(_|$)",
  minLength: 8,
}

interface LoadedRegistry {
  entries: CompiledRegistryEntry[]
  envScan?: EnvScanConfig
}

function warnRegistry(message: string): void {
  console.warn(`[opencode-secrets] registry: ${message}`)
}

/**
 * Parse + validate the JSON registry. Invalid entries are skipped with a
 * warning; a malformed registry is never fatal. Legacy {name, value|env}
 * entries map to plain obfuscate entries.
 */
function loadRegistryFile(path: string): LoadedRegistry {
  const result: LoadedRegistry = { entries: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warnRegistry(`could not read/parse ${path} (${String(error)}); running without registry entries`)
    }
    return result
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnRegistry(`${path} must be a JSON object with an "entries" array; ignoring it`)
    return result
  }
  const root = parsed as Record<string, unknown>

  const rawEntries = root.entries
  if (rawEntries !== undefined && !Array.isArray(rawEntries)) {
    warnRegistry(`"entries" must be an array; ignoring it`)
  } else if (Array.isArray(rawEntries)) {
    rawEntries.forEach((raw, index) => {
      const compiled = compileRegistryEntry(raw as Record<string, unknown>, index)
      if (compiled) result.entries.push(compiled)
    })
  }

  if (root.envScan !== undefined) {
    if (root.envScan !== null && typeof root.envScan === "object" && !Array.isArray(root.envScan)) {
      const scan = root.envScan as Record<string, unknown>
      const pattern = typeof scan.pattern === "string" && scan.pattern.length > 0 ? scan.pattern : DEFAULT_ENV_SCAN.pattern
      const minLength =
        typeof scan.minLength === "number" && Number.isFinite(scan.minLength) && scan.minLength >= 1
          ? Math.floor(scan.minLength)
          : DEFAULT_ENV_SCAN.minLength
      try {
        new RegExp(pattern, "i")
        result.envScan = { pattern, minLength }
      } catch (error) {
        warnRegistry(`envScan.pattern is not a valid regex (${String(error)}); envScan disabled`)
      }
    } else {
      warnRegistry(`"envScan" must be an object; ignoring it`)
    }
  }

  return result
}

function compileRegistryEntry(raw: Record<string, unknown>, index: number): CompiledRegistryEntry | undefined {
  if (raw === null || typeof raw !== "object") {
    warnRegistry(`entries[${index}]: entry must be an object; skipping`)
    return undefined
  }

  const type = raw.type === undefined ? "plain" : raw.type
  if (type !== "plain" && type !== "regex") {
    warnRegistry(`entries[${index}]: type must be "plain" or "regex"; skipping`)
    return undefined
  }

  const mode = raw.mode === undefined ? "obfuscate" : raw.mode
  if (mode !== "obfuscate" && mode !== "replace") {
    warnRegistry(`entries[${index}]: mode must be "obfuscate" or "replace"; skipping`)
    return undefined
  }
  if (raw.replacement !== undefined && typeof raw.replacement !== "string") {
    warnRegistry(`entries[${index}]: replacement must be a string; skipping`)
    return undefined
  }
  if (raw.flags !== undefined && typeof raw.flags !== "string") {
    warnRegistry(`entries[${index}]: flags must be a string; skipping`)
    return undefined
  }

  // Content resolution: new {content}, legacy {value}, legacy {env}.
  let content: unknown = raw.content
  if (content === undefined && raw.value !== undefined) content = raw.value
  if (content === undefined && raw.env !== undefined) {
    if (typeof raw.env !== "string" || raw.env.length === 0) {
      warnRegistry(`entries[${index}]: env must be a non-empty string; skipping`)
      return undefined
    }
    const envValue = process.env[raw.env]
    if (!envValue) {
      warnRegistry(`entries[${index}]: env ${raw.env} is not set; skipping`)
      return undefined
    }
    content = envValue
  }
  if (typeof content !== "string" || content.length === 0) {
    warnRegistry(`entries[${index}]: content/value must be a non-empty string; skipping`)
    return undefined
  }

  let friendlyName: string | undefined
  const labelSource = raw.friendlyName ?? raw.name
  if (labelSource !== undefined) {
    if (typeof labelSource !== "string") {
      warnRegistry(`entries[${index}]: friendlyName/name must be a string; ignoring the label`)
    } else {
      friendlyName = sanitizeFriendlyName(labelSource)
      if (friendlyName === undefined) {
        warnRegistry(`entries[${index}]: label must contain a letter or digit; ignoring the label`)
      }
    }
  }

  if (type === "regex") {
    let regex: RegExp
    try {
      regex = compileSecretRegex(content, raw.flags as string | undefined)
    } catch (error) {
      warnRegistry(`entries[${index}]: invalid regex (${String(error)}); skipping`)
      return undefined
    }
    if (mode === "replace" && raw.replacement === undefined && regexHasUnresolvableShortMatchFallback(regex)) {
      warnRegistry(
        `entries[${index}]: regex can match 1-2 character spans with no replacement that differs from the ` +
          `match; skipping`,
      )
      return undefined
    }
    return { type, content, mode, replacement: raw.replacement as string | undefined, friendlyName }
  }

  return { type, content, mode, replacement: raw.replacement as string | undefined, friendlyName }
}

function loadLearned(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(LEARNED_FILE, "utf8"))
    if (parsed?.learned && typeof parsed.learned === "object" && !Array.isArray(parsed.learned)) {
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed.learned)) {
        if (typeof value === "string") out[key] = value
      }
      return out
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn(`[opencode-secrets] learned file unreadable/malformed, ignoring: ${String(error)}`)
    }
  }
  return {}
}

function persistLearned(learned: Record<string, string>): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(LEARNED_FILE, JSON.stringify({ learned }, null, 2) + "\n", { mode: 0o600 })
  } catch {
    // Persistence is best-effort; scrubbing still works in-session.
  }
}

// ---------------------------------------------------------------------------
// Secret store
// ---------------------------------------------------------------------------

interface RegexEntry {
  regex: RegExp
  mode: "obfuscate" | "replace"
  replacement?: string
  friendlyName?: string
  /** Cheap literal prefixes probed before running the regex (pi fast path). */
  probes: readonly string[] | null
  builtin: boolean
}

class SecretStore {
  private plainByValue = new Map<string, string>()
  private replaceByValue = new Map<string, string>()
  private valueByPlaceholder = new Map<string, string>()
  private known = new Set<string>()
  private autoCaptured = new Set<string>()
  private regexEntries: RegexEntry[] = []
  private hasUngatedRegex = false
  private registeredLabels = new Set<string>()
  private rawDetector: RegExp | undefined
  private foldedDetector: RegExp | undefined
  private detectorDirty = true

  /** Called after the learned file was rewritten so stamps can be refreshed. */
  onLearnedPersisted: (() => void) | undefined

  learned: Record<string, string> = {}

  reset(): void {
    this.plainByValue = new Map()
    this.replaceByValue = new Map()
    this.valueByPlaceholder = new Map()
    this.known = new Set()
    this.autoCaptured = new Set()
    this.regexEntries = []
    this.hasUngatedRegex = false
    this.registeredLabels = new Set()
    this.learned = {}
    this.markDirty()
  }

  private markDirty(): void {
    this.detectorDirty = true
  }

  knows(value: string): boolean {
    return this.known.has(value)
  }

  isAutoCaptured(value: string): boolean {
    return this.autoCaptured.has(value)
  }

  get registeredCount(): number {
    return this.plainByValue.size + this.replaceByValue.size
  }

  get regexCount(): number {
    return this.regexEntries.length
  }

  /** Sanitized labels of everything registered (for the startup log; never values). */
  labels(): string[] {
    return [...new Set([...this.registeredLabels, ...Object.keys(this.learned)])].sort()
  }

  /**
   * Mint a placeholder for a value, registering full and unprefixed restore
   * aliases. Collisions fall back to salted bases (pi parity).
   */
  private mint(value: string, label?: string): string {
    const prefix = sanitizeFriendlyName(label)
    for (let attempt = 0; ; attempt++) {
      const base = attempt === 0 ? hashBase(value) : hashBase(`${value}\0${attempt}`)
      const unprefixed = `$$${base}$$`
      const owner = this.valueByPlaceholder.get(unprefixed)
      if (owner !== undefined && owner !== value) continue
      let full = unprefixed
      let added = !this.valueByPlaceholder.has(unprefixed)
      if (prefix) {
        full = `$$${prefix}_${base}$$`
        const prefixedOwner = this.valueByPlaceholder.get(full)
        if (prefixedOwner !== undefined && prefixedOwner !== value) continue
        if (!this.valueByPlaceholder.has(full)) added = true
        this.valueByPlaceholder.set(full, value)
      }
      this.valueByPlaceholder.set(unprefixed, value)
      if (added) this.markDirty()
      return full
    }
  }

  /** Explicit registration: registry/envScan/learned-file values. Floor 6. */
  registerExplicit(value: string, label: string | undefined, opts: { evictable?: boolean } = {}): void {
    if (!value || value.length < EXPLICIT_MIN_LEN) return
    if (this.known.has(value) || this.plainByValue.has(value) || this.replaceByValue.has(value)) return
    this.plainByValue.set(value, this.mint(value, label))
    this.known.add(value)
    if (opts.evictable) this.autoCaptured.add(value)
    const sanitizedLabel = sanitizeFriendlyName(label)
    if (sanitizedLabel) this.registeredLabels.add(sanitizedLabel)
    this.markDirty()
  }

  /** Implicit learn-on-first-sight: floor 8, persisted to the learned file. */
  capture(value: string, label: string | undefined): boolean {
    if (!value || value.includes("$$") || value.includes(BULLET_CHAR)) return false
    if (value.length < IMPLICIT_MIN_LEN) return false
    if (this.known.has(value)) return false
    this.plainByValue.set(value, this.mint(value, label))
    this.known.add(value)
    this.autoCaptured.add(value)
    const sanitizedLabel = sanitizeFriendlyName(label)
    if (sanitizedLabel) this.registeredLabels.add(sanitizedLabel)
    const labelKey = this.uniqueLearnedKey(sanitizedLabel ?? "AUTO")
    this.learned[labelKey] = value
    persistLearned(this.learned)
    this.onLearnedPersisted?.()
    this.markDirty()
    return true
  }

  private uniqueLearnedKey(base: string): string {
    if (this.learned[base] === undefined) return base
    for (let n = 2; ; n++) {
      const key = `${base}${n}`
      if (this.learned[key] === undefined) return key
    }
  }

  /** One-way replace-mode registration. No restore entry, ever. */
  registerReplace(value: string, replacement?: string): void {
    if (!value) return
    if (this.known.has(value) || this.replaceByValue.has(value)) return
    const rep = replacement ?? ensureDistinctReplacement(generateDeterministicReplacement(value), value)
    this.replaceByValue.set(value, rep)
    this.known.add(value)
    this.markDirty()
  }

  registerRegex(
    source: string,
    flags: string | undefined,
    mode: "obfuscate" | "replace",
    replacement: string | undefined,
    friendlyName: string | undefined,
    opts: { builtin?: boolean; literalPrefixes?: readonly string[] } = {},
  ): boolean {
    let regex: RegExp
    try {
      regex = compileSecretRegex(source, flags)
    } catch {
      return false
    }
    if (mode === "replace" && replacement === undefined && regexHasUnresolvableShortMatchFallback(regex)) {
      return false
    }
    const ignoreCase = regex.ignoreCase
    const probes =
      opts.literalPrefixes && opts.literalPrefixes.length > 0
        ? opts.literalPrefixes.map((p) => (ignoreCase ? p.toLowerCase() : p))
        : null
    if (probes === null && !opts.builtin) this.hasUngatedRegex = true
    const sanitizedLabel = sanitizeFriendlyName(friendlyName)
    if (sanitizedLabel) this.registeredLabels.add(sanitizedLabel)
    this.regexEntries.push({ regex, mode, replacement, friendlyName, probes, builtin: opts.builtin === true })
    this.markDirty()
    return true
  }

  /** Cheap pre-check: does this text need the capture/obfuscate/mask pipeline? */
  needsDeepScrub(text: string): boolean {
    if (text.includes("$$")) return true
    if (this.hasUngatedRegex) return true
    if (/[=:]/.test(text)) return true
    if (DUMP_GATE_RE.test(text)) return true
    return this.detectorHit(text)
  }

  /**
   * Literal detectors (pi raw/folded probe split): case-sensitive probes are
   * matched raw; ignore-case probes are matched case-insensitively. Case-
   * sensitive matching keeps short probes like "SK" from hitting every text.
   */
  private rebuildDetectors(): void {
    const rawLiterals: string[] = ["\\$\\$", ...this.plainByValue.keys(), ...this.replaceByValue.keys()]
    const foldedLiterals: string[] = []
    for (const entry of this.regexEntries) {
      if (entry.probes === null) continue
      if (entry.regex.ignoreCase) foldedLiterals.push(...entry.probes)
      else rawLiterals.push(...entry.probes)
    }
    this.rawDetector = new RegExp(rawLiterals.map(escapeRegExp).join("|"))
    this.foldedDetector =
      foldedLiterals.length > 0 ? new RegExp(foldedLiterals.map(escapeRegExp).join("|"), "i") : undefined
    this.detectorDirty = false
  }

  private detectorHit(text: string): boolean {
    if (this.detectorDirty) this.rebuildDetectors()
    if (this.rawDetector?.test(text)) return true
    return this.foldedDetector?.test(text) ?? false
  }

  private knownPlaceholderRanges(text: string): Array<{ start: number; end: number }> {
    reset(PLACEHOLDER_RE)
    const ranges: Array<{ start: number; end: number }> = []
    for (let m = PLACEHOLDER_RE.exec(text); m !== null; m = PLACEHOLDER_RE.exec(text)) {
      if (this.valueByPlaceholder.has(m[0])) ranges.push({ start: m.index, end: m.index + m[0].length })
    }
    reset(PLACEHOLDER_RE)
    return ranges
  }

  /** Replace occurrences of `search` that do not sit inside a known placeholder. */
  private replaceOutside(text: string, search: string, replacement: string): string {
    if (!text.includes(search)) return text
    const ranges = this.knownPlaceholderRanges(text)
    let out = ""
    let pos = 0
    let i = 0
    for (;;) {
      const idx = text.indexOf(search, i)
      if (idx === -1) break
      const end = idx + search.length
      if (ranges.some((r) => idx < r.end && end > r.start)) {
        i = idx + 1
        continue
      }
      out += text.slice(pos, idx) + replacement
      pos = end
      i = end
    }
    out += text.slice(pos)
    return out
  }

  /** Span-local placeholder: restorable in-session, never persisted/registered. */
  placeholderForSpan(value: string, label: string | undefined): string {
    return this.mint(value, label)
  }

  private entryProbesHit(entry: RegexEntry, text: string): boolean {
    if (entry.probes === null) return true
    const haystack = entry.regex.ignoreCase ? text.toLowerCase() : text
    return entry.probes.some((probe) => haystack.includes(probe))
  }

  private regexReplacement(value: string, regex: RegExp, text: string, start: number, end: number): string {
    const context: RegexMatchContext = { text, start, end }
    let replacement = generateDeterministicReplacement(value)
    if (replacement === value || regexRematchesInContext(replacement, regex, context)) {
      const stable = findNonMatchingReplacement(value, regex, context)
      replacement =
        stable ??
        (value.length <= 2
          ? buildKeyedReplacementRun(KEY, value.length)
          : `ZZ${buildKeyedReplacementRun(KEY, value.length - 2)}`)
    }
    return replacement
  }

  private collectMatches(regex: RegExp, text: string): Array<{ start: number; end: number; value: string }> {
    const ranges = this.knownPlaceholderRanges(text)
    reset(regex)
    const out: Array<{ start: number; end: number; value: string }> = []
    for (let m = regex.exec(text); m !== null; m = regex.exec(text)) {
      if (m[0].length === 0) {
        regex.lastIndex++
        continue
      }
      const start = m.index
      const end = start + m[0].length
      if (ranges.some((r) => start < r.end && end > r.start)) continue
      out.push({ start, end, value: m[0] })
    }
    reset(regex)
    return out.reverse()
  }

  /**
   * Order mirrors pi: replace-mode plain entries, then regex entries, then
   * plain obfuscate placeholders.
   */
  obfuscate(text: string): string {
    let result = text

    for (const [value, replacement] of [...this.replaceByValue].sort((a, b) => b[0].length - a[0].length)) {
      if (result.includes(value)) result = this.replaceOutside(result, value, replacement)
    }

    for (const entry of this.regexEntries) {
      if (!this.entryProbesHit(entry, result)) continue
      const matches = this.collectMatches(entry.regex, result)
      for (const match of matches) {
        if (entry.mode === "replace") {
          const replacement =
            entry.replacement ?? this.regexReplacement(match.value, entry.regex, result, match.start, match.end)
          result = result.slice(0, match.start) + replacement + result.slice(match.end)
        } else {
          if (match.value.length < IMPLICIT_MIN_LEN) continue
          let placeholder = this.plainByValue.get(match.value)
          if (placeholder === undefined) {
            placeholder = this.mint(match.value, entry.friendlyName)
            this.known.add(match.value)
            if (
              entry.builtin &&
              !this.autoCaptured.has(match.value) &&
              !looksLikeRegexSource(match.value)
            ) {
              // Persist vendor tokens so placeholders restore in later sessions.
              const labelKey = this.uniqueLearnedKey(sanitizeFriendlyName(entry.friendlyName) ?? "AUTO")
              this.learned[labelKey] = match.value
              this.autoCaptured.add(match.value)
              persistLearned(this.learned)
              this.onLearnedPersisted?.()
            }
          }
          result = result.slice(0, match.start) + placeholder + result.slice(match.end)
        }
      }
    }

    for (const [value, placeholder] of [...this.plainByValue].sort((a, b) => b[0].length - a[0].length)) {
      if (result.includes(value)) result = this.replaceOutside(result, value, placeholder)
    }

    return result
  }

  /** Restore every known placeholder found in the text to its real value. */
  restore(text: string): string {
    if (!text.includes("$$")) return text
    return text.replace(PLACEHOLDER_RE, (full) => {
      const mapped = this.valueByPlaceholder.get(full)
      if (mapped !== undefined) return mapped
      const unprefixed = /^\$\$[A-Z0-9]+_([A-Z0-9]{12})\$\$$/.exec(full)
      if (unprefixed) {
        const alias = this.valueByPlaceholder.get(`$$${unprefixed[1]}$$`)
        if (alias !== undefined) return alias
      }
      return full
    })
  }

  /**
   * evictContradicted support: un-learn an auto-captured value. Registry
   * values are never evicted; learned values are removed from the learned
   * file too (delete-to-forget).
   */
  evict(value: string): boolean {
    if (!this.autoCaptured.has(value)) return false
    this.autoCaptured.delete(value)
    this.plainByValue.delete(value)
    for (const [ph, mapped] of [...this.valueByPlaceholder]) {
      if (mapped === value) this.valueByPlaceholder.delete(ph)
    }
    this.known.delete(value)
    const labelKey = Object.keys(this.learned).find((key) => this.learned[key] === value)
    if (labelKey !== undefined) {
      delete this.learned[labelKey]
      persistLearned(this.learned)
      this.onLearnedPersisted?.()
    }
    this.markDirty()
    return true
  }
}

// ---------------------------------------------------------------------------
// Scrub pipeline (pi at-rest.ts: evict -> capture -> obfuscate -> hashShapes)
// ---------------------------------------------------------------------------

/** Text showing a credential-named variable with code-shaped content evicts it. */
function evictContradicted(store: SecretStore, text: string): void {
  reset(ASSIGNMENT_NAME_RE)
  for (
    let match = ASSIGNMENT_NAME_RE.exec(text);
    match !== null;
    match = ASSIGNMENT_NAME_RE.exec(text)
  ) {
    if (!isSecretName(match[1])) continue
    const valueMatch = VALUE_RE.exec(text.slice(ASSIGNMENT_NAME_RE.lastIndex))
    if (valueMatch === null) continue
    const raw = valueMatch[1] ?? valueMatch[2] ?? valueMatch[3]
    const trimmed = raw.replace(TRAILING_PUNCT_RE, "")
    if (!refusableValueShape(trimmed)) continue
    store.evict(raw)
    store.evict(trimmed)
  }
}

function captureUnregistered(
  store: SecretStore,
  text: string,
  options: { skipValueVeto?: boolean } = {},
): void {
  if (text.length === 0) return
  evictContradicted(store, text)
  const seen = new Set<string>()
  const tryCapture = (value: string, label?: string): void => {
    if (value.includes("$$") || value.includes(BULLET_CHAR)) return
    if (!options.skipValueVeto && valueVetoesRedaction(value)) return
    if (store.knows(value)) return
    if (seen.has(value)) return
    seen.add(value)
    store.capture(value, label)
  }

  for (const candidate of assignmentCandidates(text)) {
    if (valueRedactionVerdict(candidate.name, candidate.value) === "keep") continue
    tryCapture(candidate.value, candidate.name)
  }

  reset(CONNECTION_URL_RE)
  for (let match = CONNECTION_URL_RE.exec(text); match !== null; match = CONNECTION_URL_RE.exec(text)) {
    if (isCredentialLikePassword(match[1])) tryCapture(match[1], "URL_PASSWORD")
  }
  reset(CONNECTION_URL_RE)
}

interface ShapeSpan {
  start: number
  end: number
  value: string
  name: string | undefined
}

/**
 * Sub-floor values that still pass the mask gate (short passwords, short URL
 * passwords) get span-local reversible placeholders. Never registered or
 * persisted; unrestorable across sessions.
 */
function hashShapes(store: SecretStore, text: string): string {
  if (text.length === 0) return text
  const spans: ShapeSpan[] = []

  for (const candidate of assignmentCandidates(text)) {
    if (valueRedactionVerdict(candidate.name, candidate.value) === "keep") continue
    spans.push({
      start: candidate.valueStart,
      end: candidate.valueEnd,
      value: candidate.value,
      name: candidate.name,
    })
  }

  reset(CONNECTION_URL_RE)
  for (let match = CONNECTION_URL_RE.exec(text); match !== null; match = CONNECTION_URL_RE.exec(text)) {
    const password = match[1]
    if (password.includes("$$") || password.includes(BULLET_CHAR)) continue
    // Same gate as the capture path: example/localhost URLs with
    // non-credential-shaped passwords are not placeholder-ified.
    if (!isCredentialLikePassword(password)) continue
    const start = match.index + match[0].lastIndexOf(password)
    spans.push({ start, end: start + password.length, value: password, name: undefined })
  }
  reset(CONNECTION_URL_RE)

  if (spans.length === 0) return text

  const sorted = spans.sort((a, b) => a.start - b.start)
  const merged: ShapeSpan[] = []
  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end)
    } else {
      merged.push(span)
    }
  }

  for (let i = merged.length - 1; i >= 0; i--) {
    const span = merged[i]
    const placeholder = store.placeholderForSpan(span.value, span.name)
    text = text.slice(0, span.start) + placeholder + text.slice(span.end)
  }
  return text
}

function scrubString(store: SecretStore, text: string): string {
  if (!text) return text
  // Cheap gate first: foldDumpViews is ~5 full-text passes, so only strings
  // the gate already suspects pay for it. The gate's dump probes keep
  // secrets hidden in xxd/base64/od dumps triggering the pipeline.
  if (!store.needsDeepScrub(text)) return text
  const folded = foldDumpViews(store, text)
  if (!store.needsDeepScrub(folded)) return folded
  captureUnregistered(store, folded)
  let out = store.obfuscate(folded)
  out = hashShapes(store, out)
  return out
}

// ---------------------------------------------------------------------------
// JSON walking
// ---------------------------------------------------------------------------

type Transform = (s: string) => string

function isPlainObject(node: unknown): node is Record<string, unknown> {
  if (node === null || typeof node !== "object") return false
  const proto: unknown = Object.getPrototypeOf(node)
  return proto === Object.prototype || proto === null
}

/**
 * Unrestricted string walk over a JSON-ish tree; failures leave input intact.
 * Only plain objects and arrays are rebuilt — class instances (Error, Date,
 * Map, …) pass through untouched, so event.error and friends keep their shape.
 */
function walkStrings(node: unknown, fn: Transform): unknown {
  if (Array.isArray(node)) return node.map((item) => walkStrings(item, fn))
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      out[key] = typeof value === "string" ? fn(value) : walkStrings(value, fn)
    }
    return out
  }
  return node
}

function safeTransform(node: unknown, fn: Transform): unknown {
  try {
    return walkStrings(node, fn)
  } catch {
    return node
  }
}

// ---------------------------------------------------------------------------
// Store construction, envScan, hot reload
// ---------------------------------------------------------------------------

interface StoreRuntime {
  store: SecretStore
  registryPath: string
  registryStamp?: FileStamp
  learnedStamp?: FileStamp
}

function buildStoreRuntime(registryPath: string): StoreRuntime {
  const store = new SecretStore()
  const runtime: StoreRuntime = { store, registryPath }
  rebuildStore(runtime)
  return runtime
}

/** Rebuild the store from registry + learned file + key + built-in patterns. */
function rebuildStore(runtime: StoreRuntime): void {
  const store = runtime.store
  const loaded = loadRegistryFile(runtime.registryPath)
  store.reset()
  runtime.registryStamp = statStamp(runtime.registryPath)
  runtime.learnedStamp = statStamp(LEARNED_FILE)

  // Key self-protection: any tool reading the state directory sees scrambled
  // bytes instead of the raw key. Also guarantees the store is never empty.
  store.registerReplace(KEY)

  for (const entry of loaded.entries) {
    if (entry.type === "regex") {
      const ok = store.registerRegex(
        entry.content,
        entry.flags,
        entry.mode,
        entry.replacement,
        entry.friendlyName,
      )
      if (!ok) warnRegistry(`entries: one regex entry could not be loaded; see earlier warnings`)
      continue
    }
    if (entry.mode === "replace") {
      store.registerReplace(entry.content, entry.replacement)
    } else {
      store.registerExplicit(entry.content, entry.friendlyName)
    }
  }

  // Opt-in env name-pattern scan (pi collectEnvSecrets parity).
  const envScan = loaded.envScan
  if (envScan) {
    let scanRe: RegExp
    try {
      scanRe = new RegExp(envScan.pattern, "i")
    } catch {
      scanRe = new RegExp(DEFAULT_ENV_SCAN.pattern, "i")
    }
    const seen = new Set<string>()
    for (const [name, value] of Object.entries(process.env)) {
      if (!value || value.length < envScan.minLength) continue
      if (!scanRe.test(name)) continue
      if (seen.has(value)) continue
      seen.add(value)
      store.registerExplicit(value, name)
    }
    // Connection-URL passwords hidden inside env values (pi parity).
    for (const [, value] of Object.entries(process.env)) {
      if (!value) continue
      reset(CONNECTION_URL_RE)
      const match = CONNECTION_URL_RE.exec(value)
      reset(CONNECTION_URL_RE)
      if (!match) continue
      const password = match[1]
      if (password.length >= envScan.minLength && !seen.has(password)) {
        seen.add(password)
        store.registerExplicit(password, "URL_PASSWORD")
      }
      try {
        const decoded = decodeURIComponent(password)
        if (decoded !== password && decoded.length >= envScan.minLength && !seen.has(decoded)) {
          seen.add(decoded)
          store.registerExplicit(decoded, "URL_PASSWORD")
        }
      } catch {
        // Not URL-encoded; nothing more to register.
      }
    }
  }

  // Learned values from previous sessions: restorable and evictable.
  const learned = loadLearned()
  store.learned = learned
  for (const [label, value] of Object.entries(learned)) {
    store.registerExplicit(value, label, { evictable: true })
  }

  // Built-in credential patterns (obfuscate, per-pattern labels, fast probes).
  for (const pattern of BUILTIN_PATTERNS) {
    store.registerRegex(pattern.source, pattern.flags, "obfuscate", undefined, pattern.name, {
      builtin: true,
      literalPrefixes: pattern.literalPrefixes,
    })
  }

  store.onLearnedPersisted = () => {
    runtime.learnedStamp = statStamp(LEARNED_FILE)
  }
}

/** Re-stat registry + learned file; rebuild the store when either changed. */
function ensureFresh(runtime: StoreRuntime): void {
  const registryStamp = statStamp(runtime.registryPath)
  const learnedStamp = statStamp(LEARNED_FILE)
  if (stampEqual(registryStamp, runtime.registryStamp) && stampEqual(learnedStamp, runtime.learnedStamp)) {
    return
  }
  rebuildStore(runtime)
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const SYSTEM_NOTE =
  "[opencode-secrets] Secrets in this conversation appear as $$FRIENDLY_12CHARS$$ placeholders and are replaced with real values when a tool runs."

function appendSystemNote(system: unknown): void {
  if (!Array.isArray(system)) return
  const present = system.some(
    (part) => part !== null && typeof part === "object" && (part as { text?: unknown }).text?.toString?.().includes("[opencode-secrets]"),
  )
  if (present) return
  system.push({ type: "text", text: SYSTEM_NOTE })
}

/**
 * Prompt-hook contract (v2): "When rewriting text, update or remove attachment
 * mention offsets that no longer match." After scrubbing changes the prompt
 * text, relocate every attachment mention (files/agents/skills) by locating
 * its mention text in the rewritten text, scanning forward from the previously
 * relocated position. Mentions that no longer resolve — or resolve before the
 * previous match, i.e. ambiguously — have their `mention` field dropped while
 * the attachment itself is kept. mention.text is refreshed to the located
 * slice so a secret inside a mention is not echoed back through stale text.
 * Drafts without mentions (no files/agents/skills arrays) are a no-op.
 */
function repositionMentions(prompt: any, before: string, after: string): void {
  if (before === after) return
  type WithMention = { mention?: { start?: unknown; end?: unknown; text?: unknown } }
  const items: Array<{ holder: WithMention; start: number }> = []
  for (const list of [prompt?.files, prompt?.agents, prompt?.skills]) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const mention = (item as WithMention | null)?.mention
      if (mention && typeof mention.start === "number" && typeof mention.end === "number") {
        items.push({ holder: item as WithMention, start: mention.start })
      }
    }
  }
  if (items.length === 0) return
  items.sort((a, b) => a.start - b.start)
  let cursor = 0
  for (const { holder } of items) {
    const mention = holder.mention!
    const needle = typeof mention.text === "string" ? mention.text : ""
    const found = needle.length > 0 ? after.indexOf(needle, cursor) : -1
    if (found !== -1) {
      mention.start = found
      mention.end = found + needle.length
      mention.text = after.slice(found, mention.end)
      cursor = mention.end
    } else {
      delete holder.mention
    }
  }
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "list", "webfetch", "websearch"])

export default {
  id: "opencode-secrets",
  async setup(ctx: any) {
    const options = (ctx?.options ?? {}) as { enabled?: boolean; registry?: string }
    if (options.enabled === false) return

    const registryPath = options.registry ?? DEFAULT_REGISTRY
    let runtime: StoreRuntime
    try {
      runtime = buildStoreRuntime(registryPath)
    } catch (error) {
      console.error(`[opencode-secrets] failed to initialize: ${String(error)}`)
      throw error
    }
    const store = runtime.store

    // Incoming user prompts: scrub before admission, so the session file and
    // everything derived from it carry placeholders only. When the text
    // changes, attachment mention offsets are relocated or dropped (v2
    // prompt-hook contract).
    await ctx.session.hook("prompt", (event: any) => {
      try {
        ensureFresh(runtime)
        const prompt = event?.prompt
        if (typeof prompt?.text === "string") {
          const before = prompt.text
          prompt.text = scrubString(store, before)
          repositionMentions(prompt, before, prompt.text)
        }
      } catch (error) {
        console.error(`[opencode-secrets] prompt scrub failed: ${String(error)}`)
      }
    })

    // Outgoing model requests: the model never receives a real secret. The
    // walk is unrestricted so assistant replay thinking and tool arguments in
    // the transcript are covered too.
    const redactRequest = (event: any) => {
      try {
        ensureFresh(runtime)
        if (Array.isArray(event?.messages)) {
          event.messages = safeTransform(event.messages, (s) => scrubString(store, s))
        }
        if (Array.isArray(event?.system)) {
          event.system = safeTransform(event.system, (s) => scrubString(store, s))
          appendSystemNote(event.system)
        }
      } catch (error) {
        console.error(`[opencode-secrets] request scrub failed: ${String(error)}`)
      }
    }
    await ctx.session.hook("context", redactRequest)
    await ctx.session.hook("compaction", redactRequest)
    await ctx.session.hook("generate", redactRequest)
    await ctx.session.hook("title", (event: any) => {
      try {
        ensureFresh(runtime)
        if (Array.isArray(event?.messages)) {
          event.messages = safeTransform(event.messages, (s) => scrubString(store, s))
        }
        if (Array.isArray(event?.system)) {
          event.system = safeTransform(event.system, (s) => scrubString(store, s))
        }
      } catch (error) {
        console.error(`[opencode-secrets] title scrub failed: ${String(error)}`)
      }
    })

    // Tools still run on real bytes: placeholders in inputs are restored at
    // execution time (skipped for read-only tools where restoration is pointless).
    await ctx.tool.hook("execute.before", (event: any) => {
      try {
        const tool = String(event?.tool ?? "")
        if (READ_ONLY_TOOLS.has(tool.toLowerCase())) return
        if (event?.input) event.input = safeTransform(event.input, (s) => store.restore(s))
      } catch (error) {
        console.error(`[opencode-secrets] restore failed: ${String(error)}`)
      }
    })

    // Tool results are scrubbed before they are persisted or shown — on the
    // success path and the error path alike (error messages echo commands).
    await ctx.tool.hook("execute.after", (event: any) => {
      try {
        ensureFresh(runtime)
        if (event?.result !== undefined && event.result !== null) {
          event.result = safeTransform(event.result, (s) => scrubString(store, s))
        }
        if (event?.error !== undefined && event.error !== null) {
          event.error = safeTransform(event.error, (s) => scrubString(store, s))
        }
      } catch (error) {
        console.error(`[opencode-secrets] result scrub failed: ${String(error)}`)
      }
    })

    // One-line startup summary: counts and labels only, never values.
    const labels = store.labels()
    const shown = labels.slice(0, 15).join(", ")
    const suffix = labels.length > 15 ? ", \u2026" : ""
    console.log(
      `opencode-secrets: ${store.registeredCount} registered values, ${store.regexCount} patterns ` +
        `(labels: ${shown}${suffix}) — labels only; values are never logged`,
    )
  },
}
