//! Opt-in local redaction. Results use original UTF-8 byte offsets, never output offsets.
use aho_corasick::{AhoCorasick, MatchKind};
use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
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

#[derive(Clone, Copy)]
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
    protected_auto: Option<Regex>,
    scanners: Vec<Scanner>,
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
            protected_auto,
            scanners,
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

    fn protected_ranges(&self, text: &str) -> Result<ProtectedText, SafeError> {
        let mut ranges = Vec::new();
        if let Some(matcher) = &self.protected_literals {
            for m in matcher.find_overlapping_iter(text) {
                push_bounded(&mut ranges, (m.start(), m.end()), self.limits.matches)?;
            }
        }
        let mut counters = self.counters.clone();
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
                push_bounded(&mut ranges, (m.start(), m.end()), self.limits.matches)?;
            }
        }
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
        if text.len() > self.limits.input_bytes {
            return Err(SafeError);
        }
        let ProtectedText {
            ranges: protected,
            mut counters,
        } = self.protected_ranges(text)?;
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
        let mut output = String::with_capacity(text.len().min(self.limits.output_bytes));
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
                &mut output,
                &text[cursor..candidate.start],
                self.limits.output_bytes,
            )?;
            append_bounded(&mut output, replacement, self.limits.output_bytes)?;
            matches.push(RedactionMatch {
                start: candidate.start,
                end: candidate.end,
                replacement: replacement.to_owned(),
                kind: candidate.kind,
            });
            cursor = candidate.end;
        }
        append_bounded(&mut output, &text[cursor..], self.limits.output_bytes)?;
        // Replacements can reconstruct a source at their boundaries. Refuse rather
        // than cascade replacements, before committing any new private identities.
        if self
            .literal_safety
            .as_ref()
            .is_some_and(|matcher| matcher.is_match(&output))
        {
            return Err(SafeError);
        }
        for (kind, aliases) in pending {
            self.aliases.entry(kind).or_default().extend(aliases);
        }
        self.counters = counters;
        self.identity_count = identity_count;
        self.identity_bytes = identity_bytes;
        Ok(RedactionResult {
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
fn serialize_result(result: &RedactionResult, limit: usize) -> Result<String, SafeError> {
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

#[cfg(feature = "node")]
mod node {
    use super::Engine;
    use napi::{Error, JsUnknown, Result, Status, ValueType};
    use napi_derive::napi;

    fn safe_error() -> Error {
        Error::new(
            Status::InvalidArg,
            "Redaction configuration or operation is invalid",
        )
    }

    // N-API's generated String conversion errors stringify wrong-typed arguments,
    // including object contents. Validate unknown values before string conversion.
    fn string_argument(value: JsUnknown, max_bytes: usize) -> Result<String> {
        if value.get_type().map_err(|_| safe_error())? != ValueType::String {
            return Err(safe_error());
        }
        let string = value.coerce_to_string().map_err(|_| safe_error())?;
        if string.utf8_len().map_err(|_| safe_error())? > max_bytes {
            return Err(safe_error());
        }
        let utf8 = string.into_utf8().map_err(|_| safe_error())?;
        Ok(utf8.as_str().map_err(|_| safe_error())?.to_owned())
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
                engine: Engine::from_json(&config_json).map_err(|_| safe_error())?,
            })
        }
        #[napi]
        pub fn redact(&mut self, text: JsUnknown) -> Result<String> {
            let text = string_argument(text, self.engine.limits.input_bytes)?;
            let result = self.engine.redact(&text).map_err(|_| safe_error())?;
            super::serialize_result(&result, self.engine.limits.output_bytes)
                .map_err(|_| safe_error())
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
