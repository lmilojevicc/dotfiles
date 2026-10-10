use pi_redaction::{Engine, Kind};
use serde_json::json;

fn engine(literals: serde_json::Value, detectors: serde_json::Value) -> Engine {
    Engine::from_json(&json!({"literals": literals, "detectors": detectors}).to_string()).unwrap()
}

#[test]
fn inactive_and_independent_opt_ins() {
    let input = "a@b.co +1 (415) 555-2671 sk-abcdefghijklmnopqrstuvwxyz https://user:pass@example.org/x -----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----";
    assert_eq!(
        Engine::from_json("{}").unwrap().redact(input).unwrap().text,
        input
    );
    for (field, kind) in [
        ("email", Kind::Email),
        ("phone", Kind::Phone),
        ("apiToken", Kind::ApiToken),
        ("privateKey", Kind::PrivateKey),
        ("credentialUrl", Kind::CredentialUrl),
    ] {
        let mut e = engine(json!({}), json!({field: true}));
        let result = e.redact(input).unwrap();
        assert!(!result.matches.is_empty(), "{field}");
        assert!(result.matches.iter().all(|m| m.kind == kind));
    }
}

#[test]
fn literals_short_strings_filenames_and_utf8_offsets() {
    let mut e = engine(json!({"xy": "HIDDEN", "é": "ACCENT"}), json!({}));
    assert_eq!(e.redact("xy").unwrap().text, "HIDDEN");
    let result = e.redact("🙂 some-xy.json é!").unwrap();
    assert_eq!(result.text, "🙂 some-HIDDEN.json ACCENT!");
    assert_eq!((result.matches[0].start, result.matches[0].end), (10, 12));
    assert_eq!((result.matches[1].start, result.matches[1].end), (18, 20));
    assert!(e.redact(&result.text).unwrap().matches.is_empty());
}

#[test]
fn leftmost_longest_and_literal_priority() {
    let mut e = engine(
        json!({"aba": "LONG", "ab": "SHORT", "bab": "OTHER"}),
        json!({}),
    );
    let result = e.redact("abab").unwrap();
    assert_eq!(result.text, "LONGb");
    assert_eq!(result.matches.len(), 1);
    let mut e = engine(json!({"a@b.co": "EXACT"}), json!({"email": true}));
    let result = e.redact("a@b.co").unwrap();
    assert_eq!(result.text, "EXACT");
    assert_eq!(result.matches[0].kind, Kind::Literal);
    // Literal precedence cannot leave the rest of a detected secret exposed.
    let mut e = engine(json!({"b.co": "HOST"}), json!({"email": true}));
    assert!(e.redact("a@b.co").is_err());
}

#[test]
fn non_cascading_and_alias_protection() {
    let mut e = engine(json!({"private": "a@b.co"}), json!({"email": true}));
    let result = e.redact("private a@b.co").unwrap();
    assert_eq!(result.text, "a@b.co a@b.co");
    assert_eq!(result.matches.len(), 1);
    assert_eq!(e.redact(&result.text).unwrap().text, result.text);
    let mut e = engine(json!({}), json!({"email": true}));
    let result = e.redact("🙂a@b.co ☃ [EMAIL_72]").unwrap();
    assert_eq!(result.text, "🙂[EMAIL_73] ☃ [EMAIL_72]");
    assert_eq!(result.matches[0].start, 4);
    assert_eq!(result.matches[0].end, 10);
    assert!(e.redact(&result.text).unwrap().matches.is_empty());
    e.reset();
    assert!(e.redact(&result.text).unwrap().matches.is_empty());
}

#[test]
fn stable_distinct_automatic_aliases_and_reset() {
    let mut e = engine(json!({}), json!({"email": true}));
    assert_eq!(
        e.redact("a@b.co c@d.co a@b.co").unwrap().text,
        "[EMAIL_1] [EMAIL_2] [EMAIL_1]"
    );
    assert_eq!(
        e.redact("c@d.co e@f.co").unwrap().text,
        "[EMAIL_2] [EMAIL_3]"
    );
    e.reset();
    assert_eq!(e.redact("c@d.co").unwrap().text, "[EMAIL_1]");
}

#[test]
fn all_detector_examples_and_overlap_order() {
    let mut e = engine(
        json!({}),
        json!({"email": true, "phone": true, "apiToken": true, "privateKey": true, "credentialUrl": true}),
    );
    for (input, kind) in [
        ("a@b.co", Kind::Email),
        ("1234567", Kind::Phone),
        ("+1 (415) 555-2671", Kind::Phone),
        ("+44 20 7946 0958", Kind::Phone),
        ("sk-abcdefghijklmnopqrstuvwxyz", Kind::ApiToken),
        ("ghp_abcdefghijklmnopqrstuvwxyz", Kind::ApiToken),
        ("AKIAABCDEFGHIJKLMNOP", Kind::ApiToken),
        (
            "-----BEGIN RSA PRIVATE KEY-----\nYWJj\n-----END RSA PRIVATE KEY-----",
            Kind::PrivateKey,
        ),
        (
            "https://user:pass@example.org/path?q=abc",
            Kind::CredentialUrl,
        ),
        ("https://a@b.co:pass@example.org/path", Kind::CredentialUrl),
    ] {
        let result = e.redact(input).unwrap();
        assert_eq!(result.matches.len(), 1, "{kind:?}");
        assert_eq!(result.matches[0].kind, kind);
        assert_eq!(
            (result.matches[0].start, result.matches[0].end),
            (0, input.len())
        );
        assert!(e.redact(&result.text).unwrap().matches.is_empty());
    }
}

#[test]
fn phone_neighbors_and_non_secrets() {
    let mut e = engine(
        json!({}),
        json!({"phone": true, "apiToken": true, "privateKey": true, "credentialUrl": true}),
    );
    let clean = "123456 1234567890123456 x1234567x sk-short https://example.org -----BEGIN PRIVATE KEY----- unfinished";
    assert_eq!(e.redact(clean).unwrap().text, clean);
    assert_eq!(
        e.redact("1234567890 9876543210").unwrap().text,
        "[PHONE_1] [PHONE_2]"
    );
    assert_eq!(
        e.redact("(415) 555-2671, +1-212-555-1212")
            .unwrap()
            .matches
            .len(),
        2
    );
}

#[test]
fn invalid_configs_and_errors_never_include_values() {
    let configs = [
        r#"{"literals":{"":"ALIAS"}}"#,
        r#"{"literals":{"synthetic-secret":""}}"#,
        r#"{"literals":{"synthetic-secret":"ONE","different":"ONE"}}"#,
        r#"{"literals":{"synthetic-secret":"next","next":"synthetic-secret"}}"#,
        r#"{"literals":{"synthetic-secret":"synthetic-secret-tail"}}"#,
        r#"{"literals":{"synthetic-secret":"ONE","different":"ONE_LONG"}}"#,
        r#"{"literals":{"synthetic-secret":"[EMAIL_1]"}}"#,
        r#"{"literals":{"synthetic-secret":"ONE","synthetic-secret":"TWO"}}"#,
        r#"{"literals":{"synthetic-secret":3}}"#,
        r#"{"detectors":{"email":"synthetic-secret"}}"#,
        r#"{"detectors":{"unknown":true}}"#,
        r#"{"unknown":"synthetic-secret"}"#,
        r#"{"detectors":{"email":true,"email":false}}"#,
        r#"{"literals":null}"#,
        "synthetic-secret malformed json",
    ];
    for config in configs {
        let err = match Engine::from_json(config) {
            Ok(_) => panic!("invalid accepted"),
            Err(err) => err,
        };
        assert_eq!(
            err.to_string(),
            "Redaction configuration or operation is invalid"
        );
        assert!(!format!("{err:?}").contains("synthetic-secret"));
    }
}

#[test]
fn enabled_alias_family_collisions_are_checked_up_front() {
    for source in [
        "E",
        "[",
        "1",
        "01",
        "MAIL_",
        "L_123]",
        "0]",
        "xx[EMAIL_1]xx",
    ] {
        assert!(Engine::from_json(
            &json!({"literals": {source: "SAFE"}, "detectors": {"email": true}}).to_string()
        )
        .is_err());
    }
    // A disabled detector does not forbid unrelated literal sources.
    assert_eq!(
        engine(json!({"E": "MASK"}), json!({}))
            .redact("E")
            .unwrap()
            .text,
        "MASK"
    );
    assert_eq!(
        engine(json!({"xx[EMAIL_1]xx": "MASK"}), json!({}))
            .redact("xx[EMAIL_1]xx")
            .unwrap()
            .text,
        "MASK"
    );
    assert!(Engine::from_json(
        &json!({"literals": {"hidden": "EMAIL"}, "detectors": {"email": true}}).to_string()
    )
    .is_err());
}

#[test]
fn valid_alias_family_near_misses() {
    for source in ["é", "email", "abcEMAIL_1def"] {
        let mut e = engine(json!({source: "SAFE"}), json!({"email": true}));
        let input = format!("{source} a@b.co");
        assert_eq!(e.redact(&input).unwrap().text, "SAFE [EMAIL_1]");
    }
}

#[test]
fn ambiguous_detector_overlaps_refuse_instead_of_leaking() {
    let pem = "-----BEGIN PRIVATE KEY-----\nYWJj[EMAIL_1]ZA==\n-----END PRIVATE KEY-----";
    let mut e = engine(json!({}), json!({"email": true, "privateKey": true}));
    assert_eq!(
        e.redact(pem).unwrap_err().to_string(),
        "Redaction configuration or operation is invalid"
    );
    let pem = "-----BEGIN PRIVATE KEY-----\nYWJjZA==\n-----END PRIVATE KEY-----";
    let mut e = engine(json!({"YWJj": "BODY"}), json!({"privateKey": true}));
    assert!(e.redact(pem).is_err());
    let mut e = engine(json!({"pass": "PASSWORD"}), json!({"credentialUrl": true}));
    assert!(e.redact("https://user:pass@example.org").is_err());
    let mut e = engine(json!({"hidden": "abc"}), json!({"email": true}));
    assert!(e.redact("abc@b.co").is_err());
    // A failed scan must not allocate aliases for other candidates.
    assert!(e.redact("z@y.co abc@b.co").is_err());
    assert_eq!(e.redact("z@y.co").unwrap().text, "[EMAIL_1]");
    // A covering literal remains authoritative, even for a complete PEM key.
    let mut e = engine(json!({pem: "MASKED_BLOCK"}), json!({"privateKey": true}));
    assert_eq!(e.redact(pem).unwrap().text, "MASKED_BLOCK");
}

#[test]
fn dense_matches_and_malformed_pem_headers() {
    let mut e = engine(json!({}), json!({"privateKey": true, "email": true}));
    let input = "-----BEGIN PRIVATE KEY-----\n".repeat(1000);
    assert_eq!(e.redact(&input).unwrap().text, input);
    let input = "a@b.co ".repeat(1000);
    let result = e.redact(&input).unwrap();
    assert_eq!(result.matches.len(), 1000);
    assert_eq!(result.text, "[EMAIL_1] ".repeat(1000));
    assert!(e.redact(&result.text).unwrap().matches.is_empty());
}

#[test]
fn historical_alias_ids_are_reserved_across_scans_and_reset() {
    let mut e = engine(json!({}), json!({"email": true}));
    assert_eq!(
        e.redact("[EMAIL_1] a@b.co").unwrap().text,
        "[EMAIL_1] [EMAIL_2]"
    );
    assert_eq!(
        e.redact("[EMAIL_1] a@b.co c@d.co").unwrap().text,
        "[EMAIL_1] [EMAIL_2] [EMAIL_3]"
    );
    assert_eq!(
        e.redact("[EMAIL_100] a@b.co e@f.co").unwrap().text,
        "[EMAIL_100] [EMAIL_2] [EMAIL_101]"
    );
    e.reset();
    assert_eq!(
        e.redact("[EMAIL_1] [EMAIL_2] [EMAIL_101] g@h.co")
            .unwrap()
            .text,
        "[EMAIL_1] [EMAIL_2] [EMAIL_101] [EMAIL_102]"
    );
    assert_eq!(e.redact("i@j.co").unwrap().text, "[EMAIL_103]");
    let mut e = engine(json!({}), json!({"email": true, "phone": true}));
    assert_eq!(
        e.redact("[PHONE_7] [EMAIL_2] 1234567 a@b.co").unwrap().text,
        "[PHONE_7] [EMAIL_2] [PHONE_8] [EMAIL_3]"
    );
}

#[test]
fn invalid_historical_ids_and_exhaustion_fail_generically() {
    for token in [
        "[EMAIL_0]",
        "[EMAIL_01]",
        "[EMAIL_18446744073709551616]",
        "[EMAIL_999999999999999999999999999999999999999]",
    ] {
        let mut e = engine(json!({}), json!({"email": true}));
        assert_eq!(
            e.redact(token).unwrap_err().to_string(),
            "Redaction configuration or operation is invalid"
        );
    }
    let maximum = format!("[EMAIL_{}]", u64::MAX);
    let mut e = engine(json!({}), json!({"email": true}));
    assert_eq!(e.redact(&maximum).unwrap().text, maximum);
    assert!(e.redact("a@b.co").is_err());
    e.reset();
    assert!(e.redact(&format!("{maximum} a@b.co")).is_err());
    assert!(e.redact("c@d.co").is_err());
    // Existing identities remain stable even when no further IDs are available.
    let mut e = engine(json!({}), json!({"email": true}));
    assert_eq!(e.redact("a@b.co").unwrap().text, "[EMAIL_1]");
    assert_eq!(
        e.redact(&format!("{maximum} a@b.co")).unwrap().text,
        format!("{maximum} [EMAIL_1]")
    );
    assert!(e.redact("c@d.co").is_err());
    // Unrelated disabled families do not reserve IDs or activate detection.
    assert_eq!(
        engine(json!({}), json!({"phone": true}))
            .redact("[EMAIL_999999999999999999999999]")
            .unwrap()
            .text,
        "[EMAIL_999999999999999999999999]"
    );
}

#[test]
fn parenthesized_phone_area_codes_allow_adjacent_or_spaced_subscriber_groups() {
    for number in ["(415)555-0132", "(415) 555-0132", "+1 (415)555-0132"] {
        for (prefix, suffix) in [("_: ", "!"), ("🙂「", "」☃")] {
            let input = format!("{prefix}{number}{suffix}");
            assert_eq!(
                engine(json!({}), json!({})).redact(&input).unwrap().text,
                input
            );
            let mut e = engine(json!({}), json!({"phone": true}));
            let result = e.redact(&input).unwrap();
            assert_eq!(result.text, format!("{prefix}[PHONE_1]{suffix}"));
            assert_eq!(result.matches.len(), 1);
            let m = &result.matches[0];
            assert_eq!(m.kind, Kind::Phone);
            assert_eq!(
                (m.start, m.end),
                (prefix.len(), prefix.len() + number.len())
            );
            assert_eq!(e.redact(&result.text).unwrap().text, result.text);
        }
    }
}

#[test]
fn parenthesized_phone_format_does_not_relax_numeric_or_identifier_boundaries() {
    let mut e = engine(json!({}), json!({"phone": true}));
    for input in [
        "415555-0132",
        "(415555-0132",
        "(415)55-0132",
        "(415)555-01323",
        "x(415)555-0132",
        "(415)555-0132x",
        "é(415)555-0132",
        "(415)555-0132é",
    ] {
        let result = e.redact(input).unwrap();
        assert_eq!(result.text, input);
        assert!(result.matches.is_empty());
    }
}

#[test]
fn literal_alias_boundary_crossings_refuse_with_sanitized_errors() {
    for (source, alias, input) in [
        ("secret", "cretMASK", "secretMASK"),
        ("secret", "MASKse", "MASKsecret"),
        ("秘密", "密MASK", "🙂秘密MASK☃"),
        ("秘密", "MASK秘", "🙂MASK秘密☃"),
    ] {
        let mut e = engine(json!({source: alias}), json!({}));
        assert_eq!(
            e.redact(input).unwrap_err().to_string(),
            "Redaction configuration or operation is invalid"
        );
    }
}

#[test]
fn overlapping_literal_enumeration_cannot_hide_alias_boundary_crossings() {
    for literals in [
        json!({"se": "SHORT", "secret": "cretMASK"}),
        json!({"ase": "LONG", "secret": "cretMASK"}),
    ] {
        let mut e = engine(literals, json!({}));
        assert!(e.redact("asecretMASK").is_err());
    }
    for secret_alias in ["cretMASK", "ecretMASK"] {
        let mut e = engine(
            json!({"secret": secret_alias, "other": "PREFIXse"}),
            json!({}),
        );
        // Adjacent or overlapping complete aliases must not form an opaque union
        // that silently covers the literal spanning their individual boundaries.
        assert!(e.redact("PREFIXsecretMASK").is_err());
    }
}

#[test]
fn noncrossing_repeated_aliases_stay_idempotent() {
    let mut e = engine(
        json!({"secret": "cretMASK", "other": "PREFIXse"}),
        json!({}),
    );
    for input in [
        "cretMASK",
        "🙂cretMASK cretMASK☃ PREFIXse",
        "cretMASKPREFIXse",
    ] {
        let result = e.redact(input).unwrap();
        assert_eq!(result.text, input);
        assert!(result.matches.is_empty());
        assert_eq!(e.redact(&result.text).unwrap(), result);
    }
    let result = e.redact("<secret> cretMASK secret").unwrap();
    assert_eq!(result.text, "<cretMASK> cretMASK cretMASK");
    assert_eq!(result.matches.len(), 2);
    assert!(e.redact(&result.text).unwrap().matches.is_empty());
}

#[test]
fn render_boundaries_cannot_reconstruct_literal_sources() {
    for (source, alias, input) in [
        ("secret", "cretMASK", "sesecret"),
        ("secret", "MASKse", "secretcret"),
        ("秘密", "密MASK", "🙂秘秘密☃"),
        ("秘密", "MASK秘", "🙂秘密密☃"),
    ] {
        let mut e = engine(json!({source: alias}), json!({}));
        assert!(e.redact(input).is_err());
    }
    let mut e = engine(json!({"]!x": "MASKED"}), json!({"email": true}));
    assert!(e.redact("a@b.co!x").is_err());
    // The output safety refusal must not commit a staged automatic identity.
    assert_eq!(e.redact("c@d.co").unwrap().text, "[EMAIL_1]");
}
