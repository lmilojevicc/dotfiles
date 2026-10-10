//! Opt-in local redaction. Results use original UTF-8 byte offsets, never output offsets.
use aho_corasick::{AhoCorasick, MatchKind};
use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;

#[derive(Debug, Clone, Copy)]
pub struct SafeError;
impl fmt::Display for SafeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Redaction configuration or operation is invalid")
    }
}
impl std::error::Error for SafeError {}

// Reject duplicate JSON literal keys rather than silently accepting the last value.
fn literal_map<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<String, String>, D::Error> {
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a literal mapping")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            let mut result = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                if result.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate literal key"));
                }
            }
            Ok(result)
        }
    }
    d.deserialize_map(Visitor)
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Config {
    #[serde(deserialize_with = "literal_map")]
    literals: BTreeMap<String, String>,
    detectors: Detectors,
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct Detectors {
    email: bool,
    phone: bool,
    api_token: bool,
    private_key: bool,
    credential_url: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Literal,
    Email,
    Phone,
    ApiToken,
    PrivateKey,
    CredentialUrl,
}
impl Kind {
    fn label(self) -> &'static str {
        match self {
            Self::Email => "EMAIL",
            Self::Phone => "PHONE",
            Self::ApiToken => "API_TOKEN",
            Self::PrivateKey => "PRIVATE_KEY",
            Self::CredentialUrl => "CREDENTIAL_URL",
            Self::Literal => unreachable!(),
        }
    }
    #[cfg(any(test, feature = "node"))]
    fn serialized_name(self) -> &'static str {
        match self {
            Self::Literal => "literal",
            Self::Email => "email",
            Self::Phone => "phone",
            Self::ApiToken => "apiToken",
            Self::PrivateKey => "privateKey",
            Self::CredentialUrl => "credentialUrl",
        }
    }
    fn alias_prefix(self) -> &'static [u8] {
        match self {
            Self::Email => b"[EMAIL_",
            Self::Phone => b"[PHONE_",
            Self::ApiToken => b"[API_TOKEN_",
            Self::PrivateKey => b"[PRIVATE_KEY_",
            Self::CredentialUrl => b"[CREDENTIAL_URL_",
            Self::Literal => unreachable!(),
        }
    }
    fn priority(self) -> u8 {
        match self {
            Self::Literal => 0,
            Self::PrivateKey => 1,
            Self::CredentialUrl => 2,
            Self::ApiToken => 3,
            Self::Email => 4,
            Self::Phone => 5,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct RedactionMatch {
    pub start: usize,
    pub end: usize,
    pub replacement: String,
    pub kind: Kind,
}
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct RedactionResult {
    pub text: String,
    pub matches: Vec<RedactionMatch>,
}
#[derive(Debug, Serialize)]
struct BorrowedRedactionResult<'a> {
    text: Cow<'a, str>,
    matches: Vec<RedactionMatch>,
}

// Every accepted phone candidate requires at least seven ASCII digits.
// SIMD-backed searches count only up to seven; all alias/literal work still runs.
fn has_phone_digits(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut count = 0;
    for (a, b, c) in [(b'0', b'1', b'2'), (b'3', b'4', b'5'), (b'6', b'7', b'8')] {
        count += memchr::memchr3_iter(a, b, c, bytes).take(7 - count).count();
        if count == 7 {
            return true;
        }
    }
    count + memchr::memchr_iter(b'9', bytes).take(7 - count).count() == 7
}

#[cfg(any(test, feature = "node"))]
const MARKER_DIGIT: u8 = 1;
#[cfg(any(test, feature = "node"))]
const MARKER_AT: u8 = 2;
#[cfg(any(test, feature = "node"))]
const MARKER_DASH: u8 = 4;
#[cfg(any(test, feature = "node"))]
const MARKER_API_INITIAL: u8 = 8;
#[cfg(any(test, feature = "node"))]
const MARKER_BRACKET: u8 = 16;

#[cfg(any(test, feature = "node"))]
const PREFLIGHT_ASCII_MARKERS: [u8; 128] = {
    let mut markers = [0; 128];
    let mut digit = b'0';
    while digit <= b'9' {
        markers[digit as usize] = MARKER_DIGIT;
        digit += 1;
    }
    markers[b'@' as usize] = MARKER_AT;
    markers[b'-' as usize] = MARKER_DASH;
    // All current API alternatives start with sk-, gh*/github_pat_, AKIA/AIza,
    // or xox*. These are necessary markers, not sufficient detector matches.
    markers[b's' as usize] = MARKER_API_INITIAL;
    markers[b'g' as usize] = MARKER_API_INITIAL;
    markers[b'A' as usize] = MARKER_API_INITIAL;
    markers[b'x' as usize] = MARKER_API_INITIAL;
    markers[b'[' as usize] = MARKER_BRACKET;
    markers
};

#[cfg(any(test, feature = "node"))]
fn json_byte_width(byte: u8) -> usize {
    match byte {
        b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 8 | 12 => 2,
        0..=31 => 6,
        _ => 1,
    }
}

#[cfg(any(test, feature = "node"))]
struct Utf16Token {
    kind: Kind,
    end: usize,
    id: Result<u64, SafeError>,
}

#[cfg(any(test, feature = "node"))]
struct Utf16Segment {
    consumed: usize,
    bytes: usize,
    json_bytes: usize,
    phone_digits: u8,
    fallback: bool,
}

// Keep the hot scalar loop separate from cold token/map bookkeeping. The caller
// checks the six-bytes-per-unit bound before these unchecked local additions.
#[cfg(any(test, feature = "node"))]
#[inline(never)]
fn utf16_negative_segment(
    units: &[u16],
    markers: u8,
    mut phone_digits: u8,
) -> Result<Utf16Segment, SafeError> {
    let mut index = 0;
    let mut bytes = 0;
    let mut json_bytes = 0;
    let mut fallback = false;
    while index < units.len() {
        let unit = units[index];
        let (width, json_width) = if unit < 128 {
            let present = PREFLIGHT_ASCII_MARKERS[unit as usize] & markers;
            if present != 0 {
                if present == MARKER_BRACKET {
                    break;
                }
                if present == MARKER_DIGIT {
                    phone_digits += 1;
                    if phone_digits == 7 {
                        fallback = true;
                        break;
                    }
                } else {
                    fallback = true;
                    break;
                }
            }
            (1, json_byte_width(unit as u8))
        } else if unit < 0x800 {
            (2, 2)
        } else if (0xd800..=0xdbff).contains(&unit) {
            let low = units.get(index + 1).ok_or(SafeError)?;
            if !(0xdc00..=0xdfff).contains(low) {
                return Err(SafeError);
            }
            index += 1;
            (4, 4)
        } else if (0xdc00..=0xdfff).contains(&unit) {
            return Err(SafeError);
        } else {
            (3, 3)
        };
        bytes += width;
        json_bytes += json_width;
        index += 1;
    }
    Ok(Utf16Segment {
        consumed: index,
        bytes,
        json_bytes,
        phone_digits,
        fallback,
    })
}

#[derive(Clone, Copy)]
struct Candidate {
    start: usize,
    end: usize,
    kind: Kind,
    literal: Option<usize>,
}

struct Scanner {
    kind: Kind,
    regex: Regex,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Limits {
    config_bytes: usize,
    rules: usize,
    rule_bytes: usize,
    input_bytes: usize,
    matches: usize,
    identities: usize,
    identity_bytes: usize,
    output_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            config_bytes: 4 * 1024 * 1024,
            rules: 10_000,
            rule_bytes: 1024 * 1024,
            input_bytes: 8 * 1024 * 1024,
            matches: 100_000,
            identities: 10_000,
            identity_bytes: 16 * 1024 * 1024,
            output_bytes: 64 * 1024 * 1024,
        }
    }
}
fn push_bounded<T>(items: &mut Vec<T>, item: T, limit: usize) -> Result<(), SafeError> {
    if items.len() >= limit {
        return Err(SafeError);
    }
    items.push(item);
    Ok(())
}
fn append_bounded(output: &mut String, part: &str, limit: usize) -> Result<(), SafeError> {
    if output.len().checked_add(part.len()).ok_or(SafeError)? > limit {
        return Err(SafeError);
    }
    output.push_str(part);
    Ok(())
}

struct ProtectedText {
    ranges: Vec<(usize, usize)>,
    counters: HashMap<Kind, u64>,
}

pub struct Engine {
    limits: Limits,
    identity_count: usize,
    identity_bytes: usize,
    literals: Option<AhoCorasick>,
    literal_safety: Option<AhoCorasick>,
    replacements: Vec<String>,
    protected_literals: Option<AhoCorasick>,
    #[cfg(test)]
    protected_auto: Option<Regex>,
    scanners: Vec<Scanner>,
    #[cfg(any(test, feature = "node"))]
    preflight_markers: u8,
    aliases: HashMap<Kind, HashMap<String, String>>,
    counters: HashMap<Kind, u64>,
}

fn compile(pattern: &str) -> Result<Regex, SafeError> {
    Regex::new(pattern).map_err(|_| SafeError)
}
fn matcher(patterns: &[String], kind: MatchKind) -> Result<Option<AhoCorasick>, SafeError> {
    if patterns.is_empty() {
        Ok(None)
    } else {
        AhoCorasick::builder()
            .match_kind(kind)
            .build(patterns)
            .map(Some)
            .map_err(|_| SafeError)
    }
}

// Exact substring membership in the regular language `[LABEL_[1-9][0-9]*]`.
// Checking the whole infinite family at construction avoids counter-dependent leaks.
fn intersects_alias_family(value: &str, label: &str) -> bool {
    if !value.is_ascii() {
        return false;
    }
    let prefix = format!("[{label}_");
    let p = prefix.as_bytes();
    let digits = p.len() + 1;
    let terminal = digits + 1;
    let mut states: Vec<usize> = (0..=digits).collect();
    for byte in value.bytes() {
        let mut next = Vec::new();
        for state in states {
            let destination = if state < p.len() && byte == p[state] {
                Some(state + 1)
            } else if (state == p.len() && (b'1'..=b'9').contains(&byte))
                || (state == digits && byte.is_ascii_digit())
            {
                Some(digits)
            } else if state == digits && byte == b']' {
                Some(terminal)
            } else {
                None
            };
            if let Some(destination) = destination {
                next.push(destination);
            }
        }
        states = next;
        if states.is_empty() {
            return false;
        }
    }
    !states.is_empty()
}

impl Engine {
    pub fn from_json(json: &str) -> Result<Self, SafeError> {
        Self::from_json_with_limits(json, Limits::default())
    }

    fn from_json_with_limits(json: &str, limits: Limits) -> Result<Self, SafeError> {
        if json.len() > limits.config_bytes {
            return Err(SafeError);
        }
        let config: Config = serde_json::from_str(json).map_err(|_| SafeError)?;
        if config.literals.len() > limits.rules {
            return Err(SafeError);
        }
        let rule_bytes = config
            .literals
            .iter()
            .try_fold(0usize, |total, (key, value)| {
                total
                    .checked_add(key.len())
                    .and_then(|n| n.checked_add(value.len()))
                    .ok_or(SafeError)
            })?;
        if rule_bytes > limits.rule_bytes {
            return Err(SafeError);
        }
        let d = &config.detectors;
        let enabled: Vec<Kind> = [
            (d.email, Kind::Email),
            (d.phone, Kind::Phone),
            (d.api_token, Kind::ApiToken),
            (d.private_key, Kind::PrivateKey),
            (d.credential_url, Kind::CredentialUrl),
        ]
        .into_iter()
        .filter_map(|(enabled, kind)| enabled.then_some(kind))
        .collect();
        let sources: Vec<String> = config.literals.keys().cloned().collect();
        let replacements: Vec<String> = config.literals.values().cloned().collect();
        let mut seen = HashSet::new();
        let reserved = compile(r"\[(?:EMAIL|PHONE|API_TOKEN|PRIVATE_KEY|CREDENTIAL_URL)_[0-9]+\]")?;
        for alias in &replacements {
            if alias.is_empty() || !seen.insert(alias) || reserved.is_match(alias) {
                return Err(SafeError);
            }
        }
        if sources.iter().any(String::is_empty) {
            return Err(SafeError);
        }
        let source_collisions = matcher(&sources, MatchKind::Standard)?;
        let protected_literals = matcher(&replacements, MatchKind::Standard)?;
        if let Some(aliases) = &protected_literals {
            if sources.iter().any(|source| aliases.is_match(source)) {
                return Err(SafeError);
            }
            for (i, alias) in replacements.iter().enumerate() {
                if aliases
                    .find_overlapping_iter(alias)
                    .any(|m| m.pattern().as_usize() != i)
                    || source_collisions
                        .as_ref()
                        .is_some_and(|sources| sources.is_match(alias))
                {
                    return Err(SafeError);
                }
            }
        }
        for kind in &enabled {
            let token = compile(&format!(r"\[{}_[0-9]+\]", kind.label()))?;
            if sources
                .iter()
                .chain(&replacements)
                .any(|value| intersects_alias_family(value, kind.label()) || token.is_match(value))
            {
                return Err(SafeError);
            }
        }
        #[cfg(test)]
        let protected_auto = if enabled.is_empty() {
            None
        } else {
            Some(compile(&format!(
                r"\[({})_([0-9]+)\]",
                enabled
                    .iter()
                    .map(|kind| kind.label())
                    .collect::<Vec<_>>()
                    .join("|")
            ))?)
        };
        #[cfg(any(test, feature = "node"))]
        let preflight_markers = enabled.iter().fold(0, |mask, kind| {
            mask | MARKER_BRACKET
                | match kind {
                    Kind::Email | Kind::CredentialUrl => MARKER_AT,
                    Kind::Phone => MARKER_DIGIT,
                    Kind::PrivateKey => MARKER_DASH,
                    Kind::ApiToken => MARKER_API_INITIAL,
                    Kind::Literal => unreachable!(),
                }
        });
        let mut scanners = Vec::new();
        for kind in enabled {
            // Fixed local heuristics; no secret validation or external calls.
            let pattern = match kind {
                Kind::Email => {
                    r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+"
                }
                Kind::Phone => {
                    r"\+?(?:[0-9]{1,3}[ .-])?(?:\([0-9]{2,4}\)[ .-]?|[0-9]{2,4}[ .-])[0-9]{3,4}[ .-][0-9]{3,4}|\+?[0-9]{7,15}"
                }
                Kind::ApiToken => {
                    r"(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,})"
                }
                Kind::PrivateKey => {
                    r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"
                }
                Kind::CredentialUrl => r#"[A-Za-z][A-Za-z0-9+.-]*://[^\s/@<>"']+@[^\s<>"']+"#,
                Kind::Literal => unreachable!(),
            };
            scanners.push(Scanner {
                kind,
                regex: compile(pattern)?,
            });
        }
        Ok(Self {
            limits,
            identity_count: 0,
            identity_bytes: 0,
            literals: matcher(&sources, MatchKind::LeftmostLongest)?,
            literal_safety: source_collisions,
            protected_literals,
            replacements,
            #[cfg(test)]
            protected_auto,
            scanners,
            #[cfg(any(test, feature = "node"))]
            preflight_markers,
            aliases: HashMap::new(),
            counters: HashMap::new(),
        })
    }

    pub fn reset(&mut self) {
        self.aliases.clear();
        self.counters.clear();
        self.identity_count = 0;
        self.identity_bytes = 0;
    }

    fn reserve_auto_tokens(
        &self,
        text: &str,
        ranges: &mut Vec<(usize, usize)>,
        counters: &mut HashMap<Kind, u64>,
        prerequisites: bool,
    ) -> Result<(), SafeError> {
        // Keep the previous regex recognizer as the deliberately unoptimized
        // oracle, including its error timing and non-overlapping recognition.
        #[cfg(test)]
        if !prerequisites {
            if let Some(regex) = &self.protected_auto {
                for captures in regex.captures_iter(text) {
                    let digits = &captures[2];
                    if digits.starts_with('0') || digits.len() > 20 {
                        return Err(SafeError);
                    }
                    let id: u64 = digits.parse().map_err(|_| SafeError)?;
                    let kind = self
                        .scanners
                        .iter()
                        .find(|scanner| scanner.kind.label() == &captures[1])
                        .ok_or(SafeError)?
                        .kind;
                    let count = counters.entry(kind).or_default();
                    *count = (*count).max(id);
                    let m = captures.get(0).ok_or(SafeError)?;
                    push_bounded(ranges, (m.start(), m.end()), self.limits.matches)?;
                }
            }
            return Ok(());
        }
        #[cfg(not(test))]
        let _ = prerequisites;
        if self.scanners.is_empty() {
            return Ok(());
        }
        let bytes = text.as_bytes();
        for start in memchr::memchr_iter(b'[', bytes) {
            let tail = &bytes[start..];
            let kind = match tail.get(1) {
                Some(b'E') => Kind::Email,
                Some(b'P') if tail.starts_with(Kind::Phone.alias_prefix()) => Kind::Phone,
                Some(b'P') => Kind::PrivateKey,
                Some(b'A') => Kind::ApiToken,
                Some(b'C') => Kind::CredentialUrl,
                _ => continue,
            };
            let prefix = kind.alias_prefix();
            if !tail.starts_with(prefix) || !self.scanners.iter().any(|s| s.kind == kind) {
                continue;
            }
            let digit_start = start + prefix.len();
            let mut end = digit_start;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            // Validate numbers ONLY after recognizing the complete old regex
            // language. Overlong/zero decimals with another suffix are near
            // misses, not refusals. Searching every '[' retains nested matches.
            if end == digit_start || bytes.get(end) != Some(&b']') {
                continue;
            }
            let digits = &text[digit_start..end];
            if digits.starts_with('0') || digits.len() > 20 {
                return Err(SafeError);
            }
            let id: u64 = digits.parse().map_err(|_| SafeError)?;
            let count = counters.entry(kind).or_default();
            *count = (*count).max(id);
            push_bounded(ranges, (start, end + 1), self.limits.matches)?;
        }
        Ok(())
    }

    #[cfg(any(test, feature = "node"))]
    fn negative_proof_ascii(&self) -> Option<String> {
        if self.literals.is_some() || self.limits != Limits::default() {
            return None;
        }
        Some(
            PREFLIGHT_ASCII_MARKERS
                .iter()
                .enumerate()
                .filter(|(_, flags)| **flags & self.preflight_markers != 0)
                .map(|(byte, _)| byte as u8 as char)
                .collect(),
        )
    }

    #[cfg(any(test, feature = "node"))]
    fn utf16_token(&self, units: &[u16], start: usize) -> Option<Utf16Token> {
        let tail = units.get(start..)?;
        let has_prefix = |prefix: &[u8]| {
            tail.get(..prefix.len()).is_some_and(|head| {
                head.iter()
                    .zip(prefix)
                    .all(|(&unit, &byte)| unit == u16::from(byte))
            })
        };
        let kind = match tail.get(1).and_then(|&unit| u8::try_from(unit).ok()) {
            Some(b'E') => Kind::Email,
            Some(b'P') if has_prefix(Kind::Phone.alias_prefix()) => Kind::Phone,
            Some(b'P') => Kind::PrivateKey,
            Some(b'A') => Kind::ApiToken,
            Some(b'C') => Kind::CredentialUrl,
            _ => return None,
        };
        let prefix = kind.alias_prefix();
        if !has_prefix(prefix) || !self.scanners.iter().any(|s| s.kind == kind) {
            return None;
        }
        let digit_start = start + prefix.len();
        let mut end = digit_start;
        while units
            .get(end)
            .is_some_and(|unit| (u16::from(b'0')..=u16::from(b'9')).contains(unit))
        {
            end += 1;
        }
        if end == digit_start || units.get(end) != Some(&u16::from(b']')) {
            return None;
        }
        let digits = &units[digit_start..end];
        let id = if digits[0] == u16::from(b'0') || digits.len() > 20 {
            Err(SafeError)
        } else {
            digits.iter().try_fold(0u64, |id, &unit| {
                id.checked_mul(10)
                    .and_then(|n| n.checked_add(u64::from(unit - u16::from(b'0'))))
                    .ok_or(SafeError)
            })
        };
        Some(Utf16Token {
            kind,
            end: end + 1,
            id,
        })
    }

    // Literal-free negative proof: complete tokens isolate email/phone/API
    // candidates because none can cross '[' or ']'. PEM/URL markers OUTSIDE
    // tokens still force full scanning. Unknown token forms also fall back.
    // Reservations are staged until complete Unicode/input/parser validation;
    // later output refusal retains them exactly like the full core.
    #[cfg(any(test, feature = "node"))]
    fn utf16_no_candidates(&mut self, units: &[u16]) -> Result<bool, SafeError> {
        if self.literals.is_some() {
            return Ok(false);
        }
        if units.len() > self.limits.input_bytes {
            return Err(SafeError);
        }
        // At most six serialized bytes per UTF-16 unit plus fixed metadata.
        // Prove arithmetic fits once; reservations remain staged, so exact
        // input/parser decisions can be made after validating the entire input.
        units
            .len()
            .checked_mul(6)
            .and_then(|n| n.checked_add(24))
            .ok_or(SafeError)?;
        let mut bytes = 0usize;
        let mut serialized_bytes = 24usize;
        let mut reservations = None;
        let mut tokens = 0usize;
        let mut parser_error = false;
        let mut phone_digits = 0;
        let mut index = 0;
        while index < units.len() {
            let segment =
                utf16_negative_segment(&units[index..], self.preflight_markers, phone_digits)?;
            if segment.fallback {
                return Ok(false);
            }
            bytes += segment.bytes;
            serialized_bytes += segment.json_bytes;
            phone_digits = segment.phone_digits;
            index += segment.consumed;
            if index == units.len() {
                break;
            }
            let Some(token) = self.utf16_token(units, index) else {
                return Ok(false);
            };
            tokens += 1;
            if tokens > self.limits.matches {
                parser_error = true;
            }
            match token.id {
                Ok(id) => {
                    let counters = reservations.get_or_insert_with(|| self.counters.clone());
                    let count = counters.entry(token.kind).or_default();
                    *count = (*count).max(id);
                }
                Err(_) => parser_error = true,
            }
            // Recognized syntax consists solely of unescaped ASCII. Its body
            // cannot contain another token, surrogate or outside marker.
            let width = token.end - index;
            bytes += width;
            serialized_bytes += width;
            index = token.end;
        }
        if bytes > self.limits.input_bytes || parser_error {
            return Err(SafeError);
        }
        // A completed proof has no new identities/candidates. Historical IDs
        // survive later rendering/transport refusal, but never input/parser or
        // Unicode refusal, nor a false proof which leaves all work to the core.
        if let Some(counters) = reservations {
            self.counters = counters;
        }
        if bytes > self.limits.output_bytes || serialized_bytes > self.limits.output_bytes {
            return Err(SafeError);
        }
        Ok(true)
    }

    fn protected_ranges(
        &self,
        text: &str,
        prerequisites: bool,
    ) -> Result<ProtectedText, SafeError> {
        let mut ranges = Vec::new();
        if let Some(matcher) = &self.protected_literals {
            for m in matcher.find_overlapping_iter(text) {
                push_bounded(&mut ranges, (m.start(), m.end()), self.limits.matches)?;
            }
        }
        let mut counters = self.counters.clone();
        self.reserve_auto_tokens(text, &mut ranges, &mut counters, prerequisites)?;
        ranges.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for (start, end) in ranges {
            if let Some(last) = merged.last_mut() {
                if start <= last.1 {
                    last.1 = last.1.max(end);
                    continue;
                }
            }
            merged.push((start, end));
        }
        Ok(ProtectedText {
            ranges: merged,
            counters,
        })
    }

    pub fn redact(&mut self, text: &str) -> Result<RedactionResult, SafeError> {
        let result = self.redact_borrowed(text)?;
        Ok(RedactionResult {
            text: result.text.into_owned(),
            matches: result.matches,
        })
    }

    fn redact_borrowed<'a>(
        &mut self,
        text: &'a str,
    ) -> Result<BorrowedRedactionResult<'a>, SafeError> {
        self.redact_with_prerequisites(text, true)
    }

    // Tests use false as the deliberately unoptimized, identical-semantic oracle.
    fn redact_with_prerequisites<'a>(
        &mut self,
        text: &'a str,
        prerequisites: bool,
    ) -> Result<BorrowedRedactionResult<'a>, SafeError> {
        if text.len() > self.limits.input_bytes {
            return Err(SafeError);
        }
        let ProtectedText {
            ranges: protected,
            mut counters,
        } = self.protected_ranges(text, prerequisites)?;
        // Reservations never reuse historical IDs, even if later matching refuses.
        self.counters = counters.clone();
        if !protected.is_empty() {
            if let Some(matcher) = &self.literal_safety {
                // Enumerate ALL original-input literals: leftmost-longest selection
                // or alias segmentation could hide a different crossing occurrence.
                // Construction forbids any source contained in one opaque alias;
                // overlapping matches therefore cross an individual alias boundary,
                // even if adjacent aliases' merged ranges cover the entire source.
                for (index, m) in matcher.find_overlapping_iter(text).enumerate() {
                    if index >= self.limits.matches || overlaps(&protected, m.start(), m.end()) {
                        return Err(SafeError);
                    }
                }
            }
        }
        let mut candidates = Vec::new();
        // Scan each unprotected segment, so an earlier alias cannot hide a later match.
        let mut cursor = 0;
        for &(start, end) in protected
            .iter()
            .chain(std::iter::once(&(text.len(), text.len())))
        {
            if let Some(matcher) = &self.literals {
                for m in matcher.find_iter(&text[cursor..start]) {
                    push_bounded(
                        &mut candidates,
                        Candidate {
                            start: cursor + m.start(),
                            end: cursor + m.end(),
                            kind: Kind::Literal,
                            literal: Some(m.pattern().as_usize()),
                        },
                        self.limits.matches,
                    )?;
                }
            }
            cursor = end;
        }
        let literals: Vec<(usize, usize)> = candidates.iter().map(|c| (c.start, c.end)).collect();
        for scanner in &self.scanners {
            if prerequisites && scanner.kind == Kind::Phone && !has_phone_digits(text) {
                continue;
            }
            let mut key_endings: HashMap<String, Vec<usize>> = HashMap::new();
            for m in scanner.regex.find_iter(text) {
                let start = m.start();
                let mut end = m.end();
                if scanner.kind == Kind::PrivateKey {
                    let ending = m.as_str().replace("BEGIN", "END");
                    // At most seven fixed PEM labels. Index once per label to avoid
                    // quadratic suffix searches on repeated unterminated headers.
                    if !key_endings.contains_key(&ending) {
                        let mut offsets = Vec::new();
                        for (offset, _) in text.match_indices(&ending) {
                            push_bounded(&mut offsets, offset, self.limits.matches)?;
                        }
                        key_endings.insert(ending.clone(), offsets);
                    }
                    let offsets = key_endings.get(&ending).ok_or(SafeError)?;
                    let index = offsets.partition_point(|&offset| offset < end);
                    let Some(&offset) = offsets.get(index) else {
                        continue;
                    };
                    end = offset + ending.len();
                }
                if scanner.kind == Kind::Phone {
                    let digits = m.as_str().bytes().filter(u8::is_ascii_digit).count();
                    if !(7..=15).contains(&digits) || !phone_boundaries(text, start, end) {
                        continue;
                    }
                }
                if scanner.kind == Kind::ApiToken && !token_boundaries(text, start, end) {
                    continue;
                }
                if scanner.kind == Kind::Email && !email_boundaries(text, start, end) {
                    continue;
                }
                if overlaps(&protected, start, end) {
                    if !covered_by(&protected, start, end) {
                        return Err(SafeError);
                    }
                    continue;
                }
                if overlaps(&literals, start, end) {
                    if !covered_by(&literals, start, end) {
                        return Err(SafeError);
                    }
                    continue;
                }
                push_bounded(
                    &mut candidates,
                    Candidate {
                        start,
                        end,
                        kind: scanner.kind,
                        literal: None,
                    },
                    self.limits.matches,
                )?;
            }
        }
        candidates.sort_unstable_by_key(|c| (c.start, std::cmp::Reverse(c.end), c.kind.priority()));
        let mut selected = Vec::new();
        let mut previous_end = 0;
        for candidate in candidates {
            if candidate.start < previous_end {
                if candidate.end > previous_end {
                    return Err(SafeError);
                }
                continue;
            }
            previous_end = candidate.end;
            selected.push(candidate);
        }
        // Stage new identities until the entire bounded output succeeds. A refusal
        // cannot consume an ID or retain a partial private identity mapping.
        let mut pending: HashMap<Kind, HashMap<String, String>> = HashMap::new();
        let mut identity_count = self.identity_count;
        let mut identity_bytes = self.identity_bytes;
        let mut matches = Vec::new();
        // A completed zero-span scan still enforces rendering and literal safety,
        // but need not copy unchanged text into a new allocation.
        let mut output = if selected.is_empty() {
            Cow::Borrowed(text)
        } else {
            Cow::Owned(String::with_capacity(
                text.len().min(self.limits.output_bytes),
            ))
        };
        let mut cursor = 0;
        for candidate in selected {
            let replacement = if let Some(index) = candidate.literal {
                self.replacements[index].as_str()
            } else {
                let raw = &text[candidate.start..candidate.end];
                if let Some(alias) = self
                    .aliases
                    .get(&candidate.kind)
                    .and_then(|aliases| aliases.get(raw))
                {
                    alias.as_str()
                } else {
                    let aliases = pending.entry(candidate.kind).or_default();
                    if !aliases.contains_key(raw) {
                        if identity_count >= self.limits.identities {
                            return Err(SafeError);
                        }
                        let count = counters.entry(candidate.kind).or_default();
                        *count = count.checked_add(1).ok_or(SafeError)?;
                        let alias = format!("[{}_{}]", candidate.kind.label(), count);
                        identity_bytes = identity_bytes
                            .checked_add(raw.len())
                            .and_then(|n| n.checked_add(alias.len()))
                            .ok_or(SafeError)?;
                        if identity_bytes > self.limits.identity_bytes {
                            return Err(SafeError);
                        }
                        identity_count += 1;
                        aliases.insert(raw.to_owned(), alias);
                    }
                    aliases.get(raw).ok_or(SafeError)?.as_str()
                }
            };
            append_bounded(
                output.to_mut(),
                &text[cursor..candidate.start],
                self.limits.output_bytes,
            )?;
            append_bounded(output.to_mut(), replacement, self.limits.output_bytes)?;
            matches.push(RedactionMatch {
                start: candidate.start,
                end: candidate.end,
                replacement: replacement.to_owned(),
                kind: candidate.kind,
            });
            cursor = candidate.end;
        }
        if matches.is_empty() {
            if text.len() > self.limits.output_bytes {
                return Err(SafeError);
            }
        } else {
            append_bounded(output.to_mut(), &text[cursor..], self.limits.output_bytes)?;
        }
        // Replacements can reconstruct a source at their boundaries. Refuse rather
        // than cascade replacements, before committing any new private identities.
        if self
            .literal_safety
            .as_ref()
            .is_some_and(|matcher| matcher.is_match(output.as_ref()))
        {
            return Err(SafeError);
        }
        for (kind, aliases) in pending {
            self.aliases.entry(kind).or_default().extend(aliases);
        }
        self.counters = counters;
        self.identity_count = identity_count;
        self.identity_bytes = identity_bytes;
        Ok(BorrowedRedactionResult {
            text: output,
            matches,
        })
    }
}

// Both inputs are start-sorted disjoint spans. Binary search keeps sparse dictionaries cheap.
fn overlaps(ranges: &[(usize, usize)], start: usize, end: usize) -> bool {
    let index = ranges.partition_point(|&(s, _)| s < end);
    index > 0 && ranges[index - 1].1 > start
}
fn covered_by(ranges: &[(usize, usize)], start: usize, end: usize) -> bool {
    let index = ranges.partition_point(|&(s, _)| s <= start);
    if index == 0 {
        return false;
    }
    let mut covered_end = ranges[index - 1].1;
    for &(next_start, next_end) in &ranges[index..] {
        if covered_end >= end || next_start > covered_end {
            break;
        }
        covered_end = next_end;
    }
    covered_end >= end
}
fn surrounding(text: &str, start: usize, end: usize) -> (Option<char>, Option<char>) {
    (
        text[..start].chars().next_back(),
        text[end..].chars().next(),
    )
}
fn phone_boundaries(text: &str, start: usize, end: usize) -> bool {
    let (left, right) = surrounding(text, start, end);
    !left.is_some_and(|c| c.is_alphanumeric() || c == '+')
        && !right.is_some_and(|c| c.is_alphanumeric())
}
fn token_boundaries(text: &str, start: usize, end: usize) -> bool {
    let (left, right) = surrounding(text, start, end);
    !left.is_some_and(|c| c.is_alphanumeric() || c == '_')
        && !right.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '-')
}
fn email_boundaries(text: &str, start: usize, end: usize) -> bool {
    let (left, right) = surrounding(text, start, end);
    !left.is_some_and(|c| c.is_alphanumeric() || c == '@')
        && !right.is_some_and(|c| c.is_alphanumeric() || c == '@' || c == '-')
}

#[cfg(any(test, feature = "node"))]
fn serialize_result(result: &impl Serialize, limit: usize) -> Result<String, SafeError> {
    struct BoundedWriter {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl std::io::Write for BoundedWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self
                .bytes
                .len()
                .checked_add(bytes.len())
                .is_none_or(|n| n > self.limit)
            {
                return Err(std::io::Error::other("Redaction output limit exceeded"));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = BoundedWriter {
        bytes: Vec::new(),
        limit,
    };
    serde_json::to_writer(&mut writer, result).map_err(|_| SafeError)?;
    String::from_utf8(writer.bytes).map_err(|_| SafeError)
}

// Match the legacy serde JSON budget without allocating a serialized response.
#[cfg(any(test, feature = "node"))]
fn transport_budget(result: &BorrowedRedactionResult<'_>, limit: usize) -> Result<(), SafeError> {
    fn digits(value: usize) -> usize {
        if value == 0 {
            1
        } else {
            value.ilog10() as usize + 1
        }
    }
    fn escaped_bytes(text: &str) -> Result<usize, SafeError> {
        text.bytes().try_fold(0usize, |total, byte| {
            let size = json_byte_width(byte);
            total.checked_add(size).ok_or(SafeError)
        })
    }
    fn count(result: &BorrowedRedactionResult<'_>, upper: bool) -> Result<usize, SafeError> {
        let string_bytes = |text: &str| {
            if upper {
                text.len().checked_mul(6).ok_or(SafeError)
            } else {
                escaped_bytes(text)
            }
        };
        let mut total = 24usize
            .checked_add(string_bytes(&result.text)?)
            .ok_or(SafeError)?;
        for m in &result.matches {
            total = total
                .checked_add(44)
                .and_then(|n| n.checked_add(digits(m.start)))
                .and_then(|n| n.checked_add(digits(m.end)))
                .and_then(|n| n.checked_add(m.kind.serialized_name().len()))
                .and_then(|n| n.checked_add(string_bytes(&m.replacement).ok()?))
                .ok_or(SafeError)?;
        }
        total
            .checked_add(result.matches.len().saturating_sub(1))
            .ok_or(SafeError)
    }
    if count(result, true).is_ok_and(|n| n <= limit) || count(result, false)? <= limit {
        Ok(())
    } else {
        Err(SafeError)
    }
}

#[cfg(any(test, feature = "node"))]
fn spans_to_utf16(text: &str, matches: &mut [RedactionMatch]) -> Result<(), SafeError> {
    let mut byte_cursor = 0;
    let mut units = 0usize;
    for m in matches {
        if m.start < byte_cursor || m.end <= m.start {
            return Err(SafeError);
        }
        let before = text.get(byte_cursor..m.start).ok_or(SafeError)?;
        let replaced = text.get(m.start..m.end).ok_or(SafeError)?;
        let unit_count = |s: &str| {
            if s.is_ascii() {
                s.len()
            } else {
                s.chars().map(char::len_utf16).sum()
            }
        };
        units = units.checked_add(unit_count(before)).ok_or(SafeError)?;
        let start = units;
        units = units.checked_add(unit_count(replaced)).ok_or(SafeError)?;
        byte_cursor = m.end;
        m.start = start;
        m.end = units;
    }
    Ok(())
}

#[cfg(feature = "node")]
mod node {
    use super::Engine;
    use napi::{Env, Error, JsString, JsStringUtf8, JsUnknown, NapiRaw, Result, Status, ValueType};
    use napi_derive::napi;

    fn safe_error() -> Error {
        Error::new(
            Status::InvalidArg,
            "Redaction configuration or operation is invalid",
        )
    }

    // Do not stringify wrong types. Hold N-API storage and borrow its UTF-8 view.
    fn string_value(value: JsUnknown) -> Result<JsString> {
        if value.get_type().map_err(|_| safe_error())? != ValueType::String {
            return Err(safe_error());
        }
        value.coerce_to_string().map_err(|_| safe_error())
    }

    fn checked_string(value: JsUnknown, max_bytes: usize) -> Result<JsString> {
        let string = string_value(value)?;
        let bytes = string.utf8_len().map_err(|_| safe_error())?;
        if bytes > max_bytes {
            return Err(safe_error());
        }
        Ok(string)
    }

    fn string_argument(value: JsUnknown, max_bytes: usize) -> Result<JsStringUtf8> {
        string_storage(checked_string(value, max_bytes)?)
    }

    fn non_ascii_prefix(env: Env, string: JsString) -> Result<bool> {
        let mut prefix = [0u16; 64];
        let mut written = 0usize;
        // Safety: env/string are live handles from this synchronous N-API call;
        // the stack buffer has the advertised capacity, and N-API reports the
        // copied units excluding its terminator. No callback or coercion occurs.
        let status = unsafe {
            napi::sys::napi_get_value_string_utf16(
                env.raw(),
                string.raw(),
                prefix.as_mut_ptr(),
                prefix.len(),
                &mut written,
            )
        };
        if status != napi::sys::Status::napi_ok || written >= prefix.len() {
            return Err(safe_error());
        }
        Ok(prefix[..written].iter().any(|&unit| unit >= 128))
    }

    fn v1_argument(
        env: Env,
        value: JsUnknown,
        engine: &mut Engine,
    ) -> Result<Option<JsStringUtf8>> {
        let string = string_value(value)?;
        // This bounded sample chooses a representation, NOT a negative result.
        // Late Unicode or any failed proof takes the complete original route.
        // Avoid even UTF-8 length conversion on successfully proved Unicode.
        if engine.literals.is_none() && non_ascii_prefix(env, string)? {
            if string.utf16_len().map_err(|_| safe_error())? > engine.limits.input_bytes {
                return Err(safe_error());
            }
            let utf16 = string.into_utf16().map_err(|_| safe_error())?;
            let units = utf16.as_slice();
            let units = units
                .get(..units.len().checked_sub(1).ok_or_else(safe_error)?)
                .ok_or_else(safe_error)?;
            if engine
                .utf16_no_candidates(units)
                .map_err(|_| safe_error())?
            {
                return Ok(None);
            }
        }
        if string.utf8_len().map_err(|_| safe_error())? > engine.limits.input_bytes {
            return Err(safe_error());
        }
        string_storage(string).map(Some)
    }

    fn string_storage(string: JsString) -> Result<JsStringUtf8> {
        let utf8 = string.into_utf8().map_err(|_| safe_error())?;
        let text = utf8.as_str().map_err(|_| safe_error())?;
        // Node's N-API WriteUtf8 uses REPLACE_INVALID_UTF8 (WriteUtf8V2:
        // kReplaceInvalidUtf8): every orphan surrogate becomes U+FFFD. Therefore
        // absent EF BF BD proves well-formedness, including ASCII, without a
        // second large buffer. Genuine U+FFFD falls back to explicit validation.
        // Supported Node source/version evidence is recorded in native/README.md.
        if memchr::memmem::find(text.as_bytes(), b"\xef\xbf\xbd").is_some() {
            let utf16 = string.into_utf16().map_err(|_| safe_error())?;
            let units = utf16.as_slice();
            let units = units
                .get(..units.len().checked_sub(1).ok_or_else(safe_error)?)
                .ok_or_else(safe_error)?;
            if char::decode_utf16(units.iter().copied()).any(|c| c.is_err()) {
                return Err(safe_error());
            }
        }
        Ok(utf8)
    }

    #[napi(object)]
    pub struct NativeMatchV1 {
        pub start: u32,
        pub end: u32,
        pub replacement: String,
        pub kind: String,
    }
    #[napi(object)]
    pub struct NativeResultV1 {
        pub text: String,
        pub matches: Vec<NativeMatchV1>,
    }

    #[napi]
    pub struct NativeRedactor {
        engine: Engine,
    }
    #[napi]
    impl NativeRedactor {
        #[napi(constructor)]
        pub fn new(config_json: JsUnknown) -> Result<Self> {
            let config_json = string_argument(config_json, super::Limits::default().config_bytes)?;
            Ok(Self {
                engine: Engine::from_json(config_json.as_str().map_err(|_| safe_error())?)
                    .map_err(|_| safe_error())?,
            })
        }
        #[napi]
        pub fn redact(&mut self, text: JsUnknown) -> Result<String> {
            let storage = string_argument(text, self.engine.limits.input_bytes)?;
            let result = self
                .engine
                .redact_borrowed(storage.as_str().map_err(|_| safe_error())?)
                .map_err(|_| safe_error())?;
            super::serialize_result(&result, self.engine.limits.output_bytes)
                .map_err(|_| safe_error())
        }
        #[napi(js_name = "redactTextV1")]
        pub fn redact_text_v1(&mut self, env: Env, text: JsUnknown) -> Result<Option<String>> {
            let Some(storage) = v1_argument(env, text, &mut self.engine)? else {
                return Ok(None);
            };
            let result = self
                .engine
                .redact_borrowed(storage.as_str().map_err(|_| safe_error())?)
                .map_err(|_| safe_error())?;
            super::transport_budget(&result, self.engine.limits.output_bytes)
                .map_err(|_| safe_error())?;
            if result.matches.is_empty() {
                Ok(None)
            } else {
                Ok(Some(result.text.into_owned()))
            }
        }
        #[napi(js_name = "redactSpansUtf16V1")]
        pub fn redact_spans_utf16_v1(
            &mut self,
            env: Env,
            text: JsUnknown,
        ) -> Result<Option<NativeResultV1>> {
            let Some(storage) = v1_argument(env, text, &mut self.engine)? else {
                return Ok(None);
            };
            let text = storage.as_str().map_err(|_| safe_error())?;
            let mut result = self
                .engine
                .redact_borrowed(text)
                .map_err(|_| safe_error())?;
            super::transport_budget(&result, self.engine.limits.output_bytes)
                .map_err(|_| safe_error())?;
            if result.matches.is_empty() {
                return Ok(None);
            }
            super::spans_to_utf16(text, &mut result.matches).map_err(|_| safe_error())?;
            let matches = result
                .matches
                .into_iter()
                .map(|m| {
                    Ok(NativeMatchV1 {
                        start: u32::try_from(m.start).map_err(|_| safe_error())?,
                        end: u32::try_from(m.end).map_err(|_| safe_error())?,
                        replacement: m.replacement,
                        kind: m.kind.serialized_name().to_owned(),
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(Some(NativeResultV1 {
                text: result.text.into_owned(),
                matches,
            }))
        }
        #[napi(js_name = "negativeProofAsciiV1")]
        pub fn negative_proof_ascii_v1(&self) -> Option<String> {
            self.engine.negative_proof_ascii()
        }
        #[napi]
        pub fn reset(&mut self) {
            self.engine.reset();
        }
    }
}

#[cfg(test)]
mod resource_limit_tests {
    use super::*;
    const EMAIL: &str = r#"{"detectors":{"email":true}}"#;
    fn limited(config: &str, limits: Limits) -> Engine {
        Engine::from_json_with_limits(config, limits).unwrap()
    }

    #[test]
    fn config_rule_count_and_rule_bytes_caps() {
        assert!(Engine::from_json_with_limits(
            "{}",
            Limits {
                config_bytes: 1,
                ..Limits::default()
            }
        )
        .is_err());
        let config = r#"{"literals":{"a":"X","b":"Y"}}"#;
        assert!(Engine::from_json_with_limits(
            config,
            Limits {
                rules: 1,
                ..Limits::default()
            }
        )
        .is_err());
        assert!(Engine::from_json_with_limits(
            config,
            Limits {
                rule_bytes: 3,
                ..Limits::default()
            }
        )
        .is_err());
        assert!(Engine::from_json_with_limits(
            config,
            Limits {
                rules: 2,
                rule_bytes: 4,
                ..Limits::default()
            }
        )
        .is_ok());
    }

    #[test]
    fn input_match_and_opaque_span_caps() {
        let mut e = limited(
            EMAIL,
            Limits {
                input_bytes: 5,
                ..Limits::default()
            },
        );
        assert!(e.redact("a@b.co").is_err());
        let mut e = limited(
            EMAIL,
            Limits {
                matches: 1,
                ..Limits::default()
            },
        );
        assert!(e.redact("a@b.co c@d.co").is_err());
        assert_eq!(e.identity_count, 0);
        let mut e = limited(
            r#"{"literals":{"x":"Z"}}"#,
            Limits {
                matches: 1,
                ..Limits::default()
            },
        );
        assert!(e.redact("xx").is_err());
        assert!(e.redact("Z Z").is_err());
        assert_eq!(e.redact("x").unwrap().text, "Z");
        let mut e = limited(
            r#"{"detectors":{"privateKey":true}}"#,
            Limits {
                matches: 1,
                ..Limits::default()
            },
        );
        assert!(e.redact("-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY----- -----END PRIVATE KEY-----").is_err());
    }

    #[test]
    fn identity_count_cap_is_transactional_without_eviction() {
        let mut e = limited(
            EMAIL,
            Limits {
                identities: 1,
                ..Limits::default()
            },
        );
        assert!(e.redact("a@b.co c@d.co").is_err());
        assert_eq!(e.identity_count, 0);
        assert!(e.aliases.is_empty());
        assert_eq!(e.redact("c@d.co").unwrap().text, "[EMAIL_1]");
        assert!(e.redact("a@b.co").is_err());
        assert_eq!(e.redact("c@d.co").unwrap().text, "[EMAIL_1]");
        e.reset();
        assert_eq!(e.identity_count, 0);
        assert_eq!(
            e.redact("[EMAIL_1] a@b.co").unwrap().text,
            "[EMAIL_1] [EMAIL_2]"
        );
    }

    #[test]
    fn identity_bytes_cap_includes_private_values_and_aliases() {
        let mut e = limited(
            EMAIL,
            Limits {
                identity_bytes: 14,
                ..Limits::default()
            },
        );
        assert!(e.redact("a@b.co").is_err());
        assert_eq!(e.identity_bytes, 0);
        let mut e = limited(
            EMAIL,
            Limits {
                identity_bytes: 15,
                ..Limits::default()
            },
        );
        assert_eq!(e.redact("a@b.co").unwrap().text, "[EMAIL_1]");
        assert_eq!(e.identity_bytes, 15);
        assert!(e.redact("c@d.co").is_err());
        assert_eq!(e.redact("a@b.co").unwrap().text, "[EMAIL_1]");
    }

    #[test]
    fn output_caps_apply_before_expansion_and_commit() {
        let mut e = limited(
            r#"{"literals":{"x":"LONG"}}"#,
            Limits {
                output_bytes: 3,
                ..Limits::default()
            },
        );
        assert!(e.redact("x").is_err());
        assert!(e.redact("abcd").is_err());
        let mut e = limited(
            EMAIL,
            Limits {
                output_bytes: 15,
                ..Limits::default()
            },
        );
        assert!(e.redact("a@b.co c@d.co").is_err());
        assert_eq!(e.identity_count, 0);
        assert!(e.aliases.is_empty());
        assert_eq!(e.redact("c@d.co").unwrap().text, "[EMAIL_1]");
    }

    #[test]
    fn overlapping_literal_safety_scan_has_a_bounded_occurrence_budget() {
        let mut e = limited(
            r#"{"literals":{"a":"X","aa":"Y"}}"#,
            Limits {
                matches: 1,
                ..Limits::default()
            },
        );
        // One selected leftmost-longest match, but three original overlapping
        // occurrences when an opaque alias is present: refuse without skipping.
        assert!(e.redact("X aa").is_err());
        // The unchanged unprotected rendering path retains leftmost-longest.
        assert_eq!(e.redact("aa").unwrap().text, "Y");
    }

    #[test]
    fn serialized_json_caps_account_for_escaping_and_metadata() {
        let result = RedactionResult {
            text: "\n\"\\🙂".to_owned(),
            matches: Vec::new(),
        };
        let expected = serde_json::to_string(&result).unwrap();
        assert!(serialize_result(&result, expected.len() - 1).is_err());
        assert_eq!(serialize_result(&result, expected.len()).unwrap(), expected);
    }
}

#[cfg(test)]
mod optimization_tests;
