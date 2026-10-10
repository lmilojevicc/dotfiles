use super::*;
use serde_json::json;

fn compare(optimized: &mut Engine, reference: &mut Engine, text: &str) {
    let actual = optimized.redact_with_prerequisites(text, true);
    let expected = reference.redact_with_prerequisites(text, false);
    match (actual, expected) {
        (Ok(a), Ok(b)) => {
            assert_eq!(a.text, b.text);
            assert_eq!(a.matches, b.matches);
        }
        (Err(_), Err(_)) => {}
        _ => panic!("reference scan disagreement"),
    }
    assert_eq!(optimized.counters, reference.counters);
    assert_eq!(optimized.aliases, reference.aliases);
    assert_eq!(optimized.identity_count, reference.identity_count);
    assert_eq!(optimized.identity_bytes, reference.identity_bytes);
}

#[test]
fn optimized_scan_matches_unoptimized_reference_across_toggles_and_unicode() {
    let pieces = [
        "",
        "a",
        "@",
        "[]",
        "[]!",
        "🙂☃é秘密",
        "１２３４５６７",
        "٠١٢٣٤٥٦٧",
        "123456",
        "0",
        "9",
        "1234567",
        "(415)555-0132",
        "é1234567",
        "1234567é",
        "1234567890123456",
        "a@b.co",
        "x@@b.co",
        "a@b.co-",
        "sk-short",
        "sk-abcdefghijklmnopqrstuvwxyz",
        "AKIAABCDEFGHIJKLMNOP",
        "ghp_abcdefghijklmnopqrstuvwxyz",
        "https://user:pass@example.org/x",
        "https://example.org",
        "https://@host",
        "-----BEGIN PRIVATE KEY-----",
        "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----",
        "[EMAIL_1]",
        "[PHONE_7]",
        "[EMAIL_01]",
        "[PHONE_0]",
        "[EMAIL_18446744073709551615]",
        "[EMAIL_18446744073709551616]",
        "[EMAIL_1x]",
        "[PHONE_]",
        "hidden",
        "MASK",
    ];
    for mask in 0..32 {
        let config = json!({"literals":{"hidden":"MASK"}, "detectors": {
            "email": mask & 1 != 0, "phone": mask & 2 != 0,
            "apiToken": mask & 4 != 0, "privateKey": mask & 8 != 0,
            "credentialUrl": mask & 16 != 0,
        }})
        .to_string();
        let mut a = Engine::from_json(&config).unwrap();
        let mut b = Engine::from_json(&config).unwrap();
        for piece in pieces {
            compare(&mut a, &mut b, piece);
        }
        let mut seed = 0x7162_8394u32;
        for index in 0..200 {
            if index % 17 == 0 {
                a.reset();
                b.reset();
            }
            let mut input = String::new();
            for _ in 0..8 {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                input.push_str(pieces[seed as usize % pieces.len()]);
                input.push_str(["", " ", "!", "🙂", "é", "\n"][seed as usize % 6]);
            }
            compare(&mut a, &mut b, &input);
        }
    }
}

#[test]
fn prerequisites_and_borrowing_preserve_safety_and_transactional_limits() {
    for (config, texts) in [
        (
            r#"{"literals":{"secret":"cretMASK","other":"PREFIXse"}}"#,
            vec![
                "secretMASK",
                "PREFIXsecretMASK",
                "sesecret",
                "cretMASK",
                "secret",
            ],
        ),
        (
            r#"{"literals":{"]!x":"MASKED"},"detectors":{"email":true,"phone":true}}"#,
            vec![
                "[PHONE_8] a@b.co!x",
                "c@d.co",
                "[PHONE_18446744073709551615]",
                "1234567",
            ],
        ),
        (
            r#"{"detectors":{"email":true,"phone":true,"privateKey":true}}"#,
            vec![
                "-----BEGIN PRIVATE KEY-----\n[EMAIL_4]\n-----END PRIVATE KEY-----",
                "a@b.co",
                "1234567",
            ],
        ),
    ] {
        for limits in [
            Limits::default(),
            Limits {
                matches: 1,
                ..Limits::default()
            },
            Limits {
                identities: 1,
                ..Limits::default()
            },
            Limits {
                identity_bytes: 15,
                ..Limits::default()
            },
            Limits {
                input_bytes: 10,
                ..Limits::default()
            },
            Limits {
                output_bytes: 8,
                ..Limits::default()
            },
        ] {
            let mut a = Engine::from_json_with_limits(config, limits).unwrap();
            let mut b = Engine::from_json_with_limits(config, limits).unwrap();
            for text in &texts {
                compare(&mut a, &mut b, text);
            }
        }
    }
    let mut e = Engine::from_json(r#"{"detectors":{"phone":true}}"#).unwrap();
    let input = "🙂unchanged text";
    let result = e.redact_borrowed(input).unwrap();
    assert!(matches!(result.text, Cow::Borrowed(_)));
    assert_eq!(result.text.as_ptr(), input.as_ptr());
    assert!(result.matches.is_empty());
    for digit in b'0'..=b'9' {
        assert!(!has_phone_digits(&format!("🙂{}☃", digit as char)));
        assert!(has_phone_digits(&format!(
            "🙂{}☃",
            (digit as char).to_string().repeat(7)
        )));
    }
    assert!(!has_phone_digits("🙂１２٣abc"));
}

#[test]
fn utf16_conversion_preserves_original_scalar_offsets_and_rejects_invalid_spans() {
    let input = "🙂é a@b.co☃ 1234567🙂";
    let mut e = Engine::from_json(r#"{"detectors":{"email":true,"phone":true}}"#).unwrap();
    let mut result = e.redact_borrowed(input).unwrap();
    spans_to_utf16(input, &mut result.matches).unwrap();
    assert_eq!((result.matches[0].start, result.matches[0].end), (4, 10));
    assert_eq!((result.matches[1].start, result.matches[1].end), (12, 19));
    for (start, end) in [(1, 4), (0, 1), (4, 4), (9, 8), (0, 999)] {
        assert!(spans_to_utf16(
            input,
            &mut [RedactionMatch {
                start,
                end,
                replacement: "MASK".to_owned(),
                kind: Kind::Literal,
            }]
        )
        .is_err());
    }
}

#[test]
fn legacy_equivalent_budget_matches_serde_at_exact_boundaries() {
    let texts = [
        "",
        "ASCII",
        "\n\r\t\u{8}\u{c}\0\u{1}\u{1f}",
        "\"\\",
        "🙂é☃\u{fffd}",
    ];
    for text in texts {
        for n in [0, 1, 2, 10] {
            for (start, end) in [(0, 1), (9, 10), (99, 100), (999, 1000), (999999, 1000000)] {
                for kind in [
                    Kind::Literal,
                    Kind::Email,
                    Kind::Phone,
                    Kind::ApiToken,
                    Kind::PrivateKey,
                    Kind::CredentialUrl,
                ] {
                    let result = BorrowedRedactionResult {
                        text: Cow::Borrowed(text),
                        matches: (0..n)
                            .map(|_| RedactionMatch {
                                start,
                                end,
                                replacement: text.to_owned(),
                                kind,
                            })
                            .collect(),
                    };
                    let size = serde_json::to_vec(&result).unwrap().len();
                    assert!(transport_budget(&result, size - 1).is_err());
                    assert!(transport_budget(&result, size).is_ok());
                    assert!(transport_budget(&result, size + 1).is_ok());
                    assert!(transport_budget(&result, usize::MAX).is_ok());
                }
            }
        }
    }
}

#[test]
fn null_budget_and_transport_refusal_keep_legacy_identity_semantics() {
    let mut e = Engine::from_json("{}").unwrap();
    let unchanged = e.redact_borrowed("\0🙂").unwrap();
    let size = serde_json::to_vec(&unchanged).unwrap().len();
    assert!(transport_budget(&unchanged, size - 1).is_err());
    assert!(transport_budget(&unchanged, size).is_ok());
    let mut e = Engine::from_json(r#"{"detectors":{"email":true}}"#).unwrap();
    let result = e.redact_borrowed("a@b.co").unwrap();
    assert!(transport_budget(&result, 10).is_err());
    assert!(serialize_result(&result, 10).is_err());
    assert_eq!(e.redact("a@b.co").unwrap().text, "[EMAIL_1]");
    assert_eq!(e.redact("c@d.co").unwrap().text, "[EMAIL_2]");
}

#[test]
fn original_and_pinned_corpus_matches_reference_and_expected_spans() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/corpus.json")).unwrap();
    for fixture in corpus["cases"].as_array().unwrap() {
        let category = fixture["category"].as_str().unwrap();
        let input = fixture["text"].as_str().unwrap();
        let config = json!({"detectors": {category: true}}).to_string();
        let mut optimized = Engine::from_json(&config).unwrap();
        let mut reference = Engine::from_json(&config).unwrap();
        compare(&mut optimized, &mut reference, input);
        let result = optimized.redact_borrowed(input).unwrap();
        let originals: Vec<_> = result
            .matches
            .iter()
            .map(|m| &input[m.start..m.end])
            .collect();
        let expected: Vec<_> = fixture["secrets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(originals, expected);
        compare(&mut optimized, &mut reference, &result.text);
    }
}

fn compare_protected(e: &Engine, input: &str) {
    match (
        e.protected_ranges(input, true),
        e.protected_ranges(input, false),
    ) {
        (Ok(a), Ok(b)) => {
            assert_eq!(a.ranges, b.ranges);
            assert_eq!(a.counters, b.counters);
        }
        (Err(_), Err(_)) => {}
        _ => panic!("protected token regex/parser disagreement"),
    }
}

fn detectors_for_mask(mask: u32) -> String {
    json!({"detectors": {
        "email": mask & 1 != 0, "phone": mask & 2 != 0,
        "apiToken": mask & 4 != 0, "privateKey": mask & 8 != 0,
        "credentialUrl": mask & 16 != 0,
    }})
    .to_string()
}

#[test]
fn explicit_token_parser_matches_regex_on_nested_malformed_and_all_enabled_families() {
    let pieces = [
        "[",
        "]",
        "[[",
        "🙂é",
        "[EMAIL_1]",
        "[PHONE_7]",
        "[API_TOKEN_10]",
        "[PRIVATE_KEY_99]",
        "[CREDENTIAL_URL_100]",
        "[[EMAIL_2]]",
        "[EMAIL_[PHONE_3]]",
        "[EMAIL_0]",
        "[PHONE_01]",
        "[API_TOKEN_0001]",
        "[PRIVATE_KEY_18446744073709551615]",
        "[CREDENTIAL_URL_18446744073709551616]",
        "[EMAIL_999999999999999999999999999999x]",
        "[PHONE_999999999999999999999999999999",
        "[EMAIL_1x]",
        "[PHONE_]",
        "[EMAIL_１２]",
        "[phone_8]",
        "[EMAIL_9\0]",
        "[EMAIL_1\n]",
        "[EMAIL_1][PHONE_2]",
        "[PRIVATE_KEY_7[EMAIL_3]]",
        "[EMAIL_01x][PHONE_3]",
        "a@b.co",
        "1234567",
    ];
    for mask in 0..32 {
        let config = detectors_for_mask(mask);
        let mut a = Engine::from_json(&config).unwrap();
        let mut b = Engine::from_json(&config).unwrap();
        for piece in pieces {
            compare_protected(&a, piece);
            compare(&mut a, &mut b, piece);
        }
        let mut seed = 0x7345_6291u32;
        for index in 0..300 {
            if index % 19 == 0 {
                a.reset();
                b.reset();
            }
            let mut input = String::new();
            for _ in 0..12 {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                input.push_str(pieces[seed as usize % pieces.len()]);
            }
            compare_protected(&a, &input);
            compare(&mut a, &mut b, &input);
        }
    }
}

#[test]
fn explicit_token_parser_exhaustive_numeric_syntax_and_span_budget_parity() {
    let alphabet = ['0', '1', '9', '[', ']', 'x'];
    for (field, label) in [
        ("email", "EMAIL"),
        ("phone", "PHONE"),
        ("apiToken", "API_TOKEN"),
        ("privateKey", "PRIVATE_KEY"),
        ("credentialUrl", "CREDENTIAL_URL"),
    ] {
        for enabled in [true, false] {
            let e = Engine::from_json(&json!({"detectors": {field: enabled}}).to_string()).unwrap();
            for length in 0..=4 {
                for mut n in 0..6usize.pow(length) {
                    let mut suffix = String::new();
                    for _ in 0..length {
                        suffix.push(alphabet[n % 6]);
                        n /= 6;
                    }
                    for ending in ["", "]", "x]", "[EMAIL_1]]"] {
                        compare_protected(&e, &format!("🙂[[{label}_{suffix}{ending}☃"));
                    }
                }
            }
            for suffix in [
                "0",
                "01",
                "1",
                "9",
                "18446744073709551615",
                "18446744073709551616",
                "999999999999999999999999999999999999999999",
            ] {
                compare_protected(&e, &format!("[{label}_{suffix}][{label}_1]"));
                compare_protected(&e, &format!("[{label}_{suffix}x][{label}_2]"));
            }
        }
    }
    let config = r#"{"literals":{"secret":"MASK"},"detectors":{"email":true,"phone":true}}"#;
    for cap in 0..=4 {
        let limits = Limits {
            matches: cap,
            ..Limits::default()
        };
        let mut a = Engine::from_json_with_limits(config, limits).unwrap();
        let mut b = Engine::from_json_with_limits(config, limits).unwrap();
        for input in [
            "[EMAIL_1][PHONE_2]",
            "MASK [EMAIL_3] [EMAIL_4]",
            "[EMAIL_9] secret a@b.co",
            "[EMAIL_0]",
            "a@b.co",
        ] {
            compare_protected(&a, input);
            compare(&mut a, &mut b, input);
        }
    }
}

#[test]
fn utf16_negative_proof_matches_full_reference_across_toggles_and_marker_boundaries() {
    let clean = "🙂é 名 café ordinary clean line\n\u{fffd}\0";
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/corpus.json")).unwrap();
    for mask in 0..32 {
        let config = detectors_for_mask(mask);
        let mut e = Engine::from_json(&config).unwrap();
        let mut inputs = vec![clean.to_owned(), "".to_owned(), "１２٣٤☃".to_owned()];
        for marker in ['[', '@', '-', '0', '9', 's', 'g', 'A', 'x'] {
            inputs.push(format!("{marker}{clean}"));
            inputs.push(format!("{clean}{marker}"));
        }
        for fixture in corpus["cases"].as_array().unwrap() {
            inputs.push(format!("🙂{}", fixture["text"].as_str().unwrap()));
        }
        for input in inputs {
            let units: Vec<_> = input.encode_utf16().collect();
            let before_counters = e.counters.clone();
            if e.utf16_no_candidates(&units).unwrap() {
                let mut reference = Engine::from_json(&config).unwrap();
                let result = reference.redact_with_prerequisites(&input, false).unwrap();
                assert!(result.matches.is_empty());
                assert_eq!(result.text, input);
                assert!(reference.counters.is_empty());
                transport_budget(&result, reference.limits.output_bytes).unwrap();
            }
            assert_eq!(e.counters, before_counters);
        }
        assert!(e
            .utf16_no_candidates(&clean.encode_utf16().collect::<Vec<_>>())
            .unwrap());
        let alias_input = "🙂[EMAIL_99]";
        let mut reference = Engine::from_json(&config).unwrap();
        let result = reference
            .redact_with_prerequisites(alias_input, false)
            .unwrap();
        if e.utf16_no_candidates(&alias_input.encode_utf16().collect::<Vec<_>>())
            .unwrap()
        {
            assert!(result.matches.is_empty());
            assert_eq!(e.counters, reference.counters);
        }
    }
    let mut api = Engine::from_json(r#"{"detectors":{"apiToken":true}}"#).unwrap();
    for token in [
        "sk-abcdefghijklmnopqrstuvwxyz",
        "sk-proj-abcdefghijklmnopqrstuvwxyz",
        "sk-svcacct-abcdefghijklmnopqrstuvwxyz",
        "ghp_abcdefghijklmnopqrstuvwxyz",
        "gho_abcdefghijklmnopqrstuvwxyz",
        "ghu_abcdefghijklmnopqrstuvwxyz",
        "ghs_abcdefghijklmnopqrstuvwxyz",
        "ghr_abcdefghijklmnopqrstuvwxyz",
        "github_pat_abcdefghijklmnopqrstuvwxyz",
        "AKIAABCDEFGHIJKLMNOP",
        "AIzaabcdefghijklmnopqrstuvwxyz012345678",
        "xoxb-abcdefghijk",
        "xoxa-abcdefghijk",
        "xoxp-abcdefghijk",
        "xoxr-abcdefghijk",
        "xoxs-abcdefghijk",
    ] {
        for input in [format!("🙂{token}"), format!("{token}🙂")] {
            assert_eq!(api.redact(&input).unwrap().matches.len(), 1);
            assert!(!api
                .utf16_no_candidates(&input.encode_utf16().collect::<Vec<_>>())
                .unwrap());
        }
    }
    let mut literal = Engine::from_json(r#"{"literals":{"é":"MASK"}}"#).unwrap();
    assert!(!literal.utf16_no_candidates(&[0xe9]).unwrap());
}

#[test]
fn utf16_negative_proof_exact_bytes_render_and_transport_boundaries() {
    for input in [
        "",
        "é",
        "名",
        "🙂",
        "\u{fffd}",
        "\0\u{1}\u{8}\t\n\u{c}\r\u{1f}\"\\é🙂",
    ] {
        let units: Vec<_> = input.encode_utf16().collect();
        let serialized = serde_json::to_vec(&RedactionResult {
            text: input.to_owned(),
            matches: vec![],
        })
        .unwrap()
        .len();
        for input_cap in [input.len().saturating_sub(1), input.len(), input.len() + 1] {
            for output_cap in [
                input.len().saturating_sub(1),
                input.len(),
                serialized - 1,
                serialized,
                serialized + 1,
            ] {
                let mut e = Engine::from_json_with_limits(
                    "{}",
                    Limits {
                        input_bytes: input_cap,
                        output_bytes: output_cap,
                        ..Limits::default()
                    },
                )
                .unwrap();
                assert_eq!(
                    e.utf16_no_candidates(&units).is_ok(),
                    input.len() <= input_cap
                        && input.len() <= output_cap
                        && serialized <= output_cap
                );
            }
        }
    }
    let mut e = Engine::from_json("{}").unwrap();
    for unit in 0xd800..=0xdfff {
        for units in [
            vec![unit],
            vec![0xe9, unit],
            vec![unit, 0xfffd],
            vec![0xd83d, 0xde42, unit],
            vec![unit, unit],
        ] {
            assert!(e.utf16_no_candidates(&units).is_err());
        }
    }
    for units in [
        vec![0xd800, 0xdc00],
        vec![0xdbff, 0xdfff],
        vec![0xfffd, 0xd83d, 0xde42],
        vec![0, 0xfffd, 0],
    ] {
        assert!(e.utf16_no_candidates(&units).unwrap());
    }
}

fn assert_same_state(a: &Engine, b: &Engine) {
    assert_eq!(a.counters, b.counters);
    assert_eq!(a.aliases, b.aliases);
    assert_eq!(a.identity_count, b.identity_count);
    assert_eq!(a.identity_bytes, b.identity_bytes);
}

fn compare_utf16_pipeline(a: &mut Engine, reference: &mut Engine, input: &str) {
    let counters = a.counters.clone();
    let units: Vec<_> = input.encode_utf16().collect();
    let limit = a.limits.output_bytes;
    let actual = match a.utf16_no_candidates(&units) {
        Ok(true) => Ok(RedactionResult {
            text: input.to_owned(),
            matches: vec![],
        }),
        Ok(false) => {
            assert_eq!(
                a.counters, counters,
                "fallback must not commit reservations"
            );
            a.redact_with_prerequisites(input, true).and_then(|result| {
                transport_budget(&result, limit)?;
                Ok(RedactionResult {
                    text: result.text.into_owned(),
                    matches: result.matches,
                })
            })
        }
        Err(error) => Err(error),
    };
    let limit = reference.limits.output_bytes;
    let expected = reference
        .redact_with_prerequisites(input, false)
        .and_then(|result| {
            transport_budget(&result, limit)?;
            Ok(RedactionResult {
                text: result.text.into_owned(),
                matches: result.matches,
            })
        });
    match (actual, expected) {
        (Ok(actual), Ok(expected)) => assert_eq!(actual, expected),
        (Err(_), Err(_)) => {}
        _ => panic!("UTF16 proof/full-reference disagreement"),
    }
    assert_same_state(a, reference);
}

#[test]
fn ascii_descriptor_exact_markers_and_absence_certify_default_reference_semantics() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/corpus.json")).unwrap();
    for mask in 0..32 {
        let config = detectors_for_mask(mask);
        let e = Engine::from_json(&config).unwrap();
        let descriptor = e.negative_proof_ascii().unwrap();
        let mut expected = std::collections::BTreeSet::new();
        if mask != 0 {
            expected.insert('[');
        }
        if mask & (1 | 16) != 0 {
            expected.insert('@');
        }
        if mask & 2 != 0 {
            expected.extend('0'..='9');
        }
        if mask & 4 != 0 {
            expected.extend(['s', 'g', 'A', 'x']);
        }
        if mask & 8 != 0 {
            expected.insert('-');
        }
        assert_eq!(descriptor, expected.iter().collect::<String>());
        let mut inputs: Vec<String> = corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|fixture| fixture["text"].as_str().unwrap().to_owned())
            .collect();
        inputs.extend(
            [
                "",
                "okay",
                "🙂é名\u{fffd}\0",
                "123456",
                "[EMAIL_41]",
                "[[PHONE_73]]",
                "@ - sk ghp_ AKIA xoxb",
            ]
            .map(str::to_owned),
        );
        for unit in 0..=127u8 {
            inputs.push(format!("🙂{}☃", unit as char));
        }
        let mut seed = 0x8273_6514u32;
        for _ in 0..200 {
            let mut input = String::new();
            for _ in 0..32 {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                input.push(
                    [
                        '🙂', 'é', '☃', '[', ']', '0', '9', '@', '-', 's', 'g', 'A', 'x', 'o',
                        '\n', '\0',
                    ][seed as usize % 16],
                );
            }
            inputs.push(input);
        }
        let mut reference = Engine::from_json(&config).unwrap();
        // Exercise an existing identity/counter, not only a fresh empty engine.
        reference.redact("a@b.co 1234567").unwrap();
        for input in inputs {
            if input.chars().any(|c| descriptor.contains(c)) {
                continue;
            }
            let counters = reference.counters.clone();
            let aliases = reference.aliases.clone();
            let result = reference.redact_with_prerequisites(&input, false).unwrap();
            assert_eq!(result.text, input);
            assert!(result.matches.is_empty());
            transport_budget(&result, reference.limits.output_bytes).unwrap();
            assert_eq!(reference.counters, counters);
            assert_eq!(reference.aliases, aliases);
        }
        let literal_config = json!({"literals":{"hidden":"MASK"}, "detectors": serde_json::from_str::<serde_json::Value>(&config).unwrap()["detectors"]}).to_string();
        assert!(Engine::from_json(&literal_config)
            .unwrap()
            .negative_proof_ascii()
            .is_none());
    }
}

#[test]
fn ascii_descriptor_refuses_every_nondefault_internal_budget() {
    for limits in [
        Limits {
            config_bytes: 10,
            ..Limits::default()
        },
        Limits {
            rules: 1,
            ..Limits::default()
        },
        Limits {
            rule_bytes: 1,
            ..Limits::default()
        },
        Limits {
            input_bytes: 1,
            ..Limits::default()
        },
        Limits {
            output_bytes: 24,
            ..Limits::default()
        },
        Limits {
            matches: 0,
            ..Limits::default()
        },
        Limits {
            identities: 0,
            ..Limits::default()
        },
        Limits {
            identity_bytes: 0,
            ..Limits::default()
        },
    ] {
        assert!(Engine::from_json_with_limits("{}", limits)
            .unwrap()
            .negative_proof_ascii()
            .is_none());
    }
    assert_eq!(
        Engine::from_json("{}")
            .unwrap()
            .negative_proof_ascii()
            .as_deref(),
        Some("")
    );
}

#[test]
fn utf16_reserved_proof_matches_full_reference_across_toggles_positions_and_crossings() {
    let pieces = [
        "🙂é☃",
        "[EMAIL_41]",
        "[PHONE_73]",
        "[API_TOKEN_12]",
        "[PRIVATE_KEY_9]",
        "[CREDENTIAL_URL_5]",
        "[EMAIL_0]",
        "[PHONE_01]",
        "[API_TOKEN_18446744073709551616]",
        "[EMAIL_18446744073709551615]",
        "[EMAIL_999999999999999999999999999999x]",
        "[[EMAIL_4]]",
        "[EMAIL_[PHONE_7]]",
        "[EMAIL_１２]",
        "[unknown]",
        "1",
        "123456",
        "1234567",
        "12|34|56",
        "123[EMAIL_123456789012345]456",
        "12345[PHONE_7]67",
        "é1234567é",
        "@",
        "a@b.co",
        "-",
        "s",
        "g",
        "A",
        "x",
        "sk-abcdefghijklmnopqrstuvwxyz",
        "-----BEGIN PRIVATE KEY-----\n[EMAIL_41]\n-----END PRIVATE KEY-----",
        "https://[EMAIL_41]user:pass@example.org/x",
        "https://user:pass@[EMAIL_41]example.org",
        "[EMAIL_41]a@b.co",
        "a@b.co[PHONE_73]",
        "1234567[EMAIL_41]",
        "[EMAIL_41]1234567",
        "hidden",
        "MASK",
        "\0\n\"\\\u{fffd}",
    ];
    for mask in 0..32 {
        let config = detectors_for_mask(mask);
        for literal in [false, true] {
            let config = if literal {
                let mut value: serde_json::Value = serde_json::from_str(&config).unwrap();
                value["literals"] = json!({"hidden":"MASK"});
                value.to_string()
            } else {
                config.clone()
            };
            let mut a = Engine::from_json(&config).unwrap();
            let mut reference = Engine::from_json(&config).unwrap();
            for piece in pieces {
                for input in [
                    format!("{piece}🙂é"),
                    format!("🙂{piece}☃"),
                    format!("🙂é{piece}"),
                ] {
                    compare_utf16_pipeline(&mut a, &mut reference, &input);
                }
            }
            let mut seed = 0x4261_5938u32;
            for i in 0..150 {
                if i % 17 == 0 {
                    a.reset();
                    reference.reset();
                }
                let mut input = String::from("🙂");
                for _ in 0..8 {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    input.push_str(pieces[seed as usize % pieces.len()]);
                }
                compare_utf16_pipeline(&mut a, &mut reference, &input);
            }
        }
    }
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/corpus.json")).unwrap();
    for fixture in corpus["cases"].as_array().unwrap() {
        let category = fixture["category"].as_str().unwrap();
        let config = json!({"detectors": {category: true}}).to_string();
        let mut a = Engine::from_json(&config).unwrap();
        let mut reference = Engine::from_json(&config).unwrap();
        compare_utf16_pipeline(
            &mut a,
            &mut reference,
            &format!("🙂{}", fixture["text"].as_str().unwrap()),
        );
    }
}

#[test]
fn utf16_reserved_proof_preserves_input_parser_output_refusal_state_order() {
    let config = r#"{"detectors":{"email":true,"phone":true}}"#;
    let inputs = [
        "🙂[EMAIL_41]",
        "🙂[EMAIL_41][PHONE_73]",
        "🙂[EMAIL_41][EMAIL_0]",
        "🙂[EMAIL_18446744073709551615]",
        "🙂[EMAIL_41]@",
        "🙂[EMAIL_41]a@b.co",
        "🙂[EMAIL_41]1234567",
        "a@b.co",
        "🙂[EMAIL_41]",
    ];
    for limits in [
        Limits::default(),
        Limits {
            matches: 0,
            ..Limits::default()
        },
        Limits {
            matches: 1,
            ..Limits::default()
        },
        Limits {
            input_bytes: 13,
            ..Limits::default()
        },
        Limits {
            input_bytes: 14,
            ..Limits::default()
        },
        Limits {
            output_bytes: 13,
            ..Limits::default()
        },
        Limits {
            output_bytes: 14,
            ..Limits::default()
        },
        Limits {
            output_bytes: 37,
            ..Limits::default()
        },
        Limits {
            output_bytes: 38,
            ..Limits::default()
        },
        Limits {
            identities: 0,
            ..Limits::default()
        },
        Limits {
            identity_bytes: 0,
            ..Limits::default()
        },
    ] {
        let mut a = Engine::from_json_with_limits(config, limits).unwrap();
        let mut reference = Engine::from_json_with_limits(config, limits).unwrap();
        for input in inputs {
            compare_utf16_pipeline(&mut a, &mut reference, input);
        }
    }
    for output_bytes in [13, 14, 37] {
        let mut a = Engine::from_json_with_limits(
            config,
            Limits {
                output_bytes,
                ..Limits::default()
            },
        )
        .unwrap();
        assert!(a
            .utf16_no_candidates(&"🙂[EMAIL_41]".encode_utf16().collect::<Vec<_>>())
            .is_err());
        assert_eq!(a.counters.get(&Kind::Email), Some(&41));
    }
    for input in [
        "🙂[EMAIL_41][EMAIL_01]",
        "🙂[EMAIL_41][EMAIL_18446744073709551616]",
    ] {
        let mut a = Engine::from_json(config).unwrap();
        assert!(a
            .utf16_no_candidates(&input.encode_utf16().collect::<Vec<_>>())
            .is_err());
        assert!(a.counters.is_empty());
    }
    let mut a = Engine::from_json(config).unwrap();
    for unit in 0xd800..=0xdfff {
        for prefix in ["🙂[EMAIL_41]", "[EMAIL_41]🙂"] {
            let mut units: Vec<_> = prefix.encode_utf16().collect();
            units.push(unit);
            assert!(a.utf16_no_candidates(&units).is_err());
            assert!(a.counters.is_empty());
        }
    }
    let mut small = Engine::from_json_with_limits(
        config,
        Limits {
            input_bytes: 13,
            ..Limits::default()
        },
    )
    .unwrap();
    assert!(small
        .utf16_no_candidates(&"🙂[EMAIL_41]".encode_utf16().collect::<Vec<_>>())
        .is_err());
    assert!(small.counters.is_empty());
}

#[test]
fn seven_digit_phone_prerequisite_is_exact_necessary_count_and_reference_equivalent() {
    for digit in '0'..='9' {
        for count in 0..=9 {
            let text = format!("🙂{}☃", digit.to_string().repeat(count));
            assert_eq!(has_phone_digits(&text), count >= 7);
        }
    }
    for text in [
        "012345",
        "0123456",
        "3456789",
        "9999999",
        "0é1🙂2☃3名4ü5[6",
        "１２３４٥٦٧٨٩",
    ] {
        assert_eq!(
            has_phone_digits(text),
            text.bytes().filter(u8::is_ascii_digit).count() >= 7
        );
    }
    let mut a = Engine::from_json(r#"{"detectors":{"phone":true}}"#).unwrap();
    let mut reference = Engine::from_json(r#"{"detectors":{"phone":true}}"#).unwrap();
    for text in [
        "123456",
        "1234567",
        "+1 (415) 555-2671",
        "+44 20 7946 0958",
        "(415)555-0132",
        "[PHONE_41]",
        "[PHONE_0]",
        "[PHONE_18446744073709551615]",
        "1234567",
    ] {
        compare(&mut a, &mut reference, text);
    }
}
