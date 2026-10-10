// Validate collision checking through the public constructor, including future counters.
use pi_redaction::Engine;
use serde_json::json;

#[test]
fn every_substring_of_future_automatic_aliases_is_rejected_when_sensitive() {
    for (field, label) in [
        ("email", "EMAIL"),
        ("phone", "PHONE"),
        ("apiToken", "API_TOKEN"),
        ("privateKey", "PRIVATE_KEY"),
        ("credentialUrl", "CREDENTIAL_URL"),
    ] {
        for number in [1_u64, 10, 101, u64::MAX] {
            let alias = format!("[{label}_{number}]");
            for start in 0..alias.len() {
                for end in start + 1..=alias.len() {
                    let source = &alias[start..end];
                    let config =
                        json!({"literals": {source: "MASKED_VALUE"}, "detectors": {field: true}});
                    assert!(
                        Engine::from_json(&config.to_string()).is_err(),
                        "{field}: {start}..{end}"
                    );
                }
            }
        }
    }
}
