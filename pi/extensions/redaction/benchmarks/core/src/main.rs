use pi_redaction::Engine;
use serde_json::{json, Value};
use std::{hint::black_box, time::Instant};

fn main() {
    let file = std::env::args()
        .nth(1)
        .expect("synthetic task file required");
    let tasks: Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let mut rows = Vec::new();
    for task in tasks.as_array().unwrap() {
        let config = task["config"].to_string();
        let input = task["text"].as_str().unwrap();
        let start = Instant::now();
        let mut engine = Engine::from_json(&config).unwrap();
        let construction_ms = start.elapsed().as_secs_f64() * 1000.0;
        let result = engine.redact(input).unwrap();
        assert_eq!(
            result.matches.len(),
            task["expectedMatches"].as_u64().unwrap() as usize
        );
        for secret in task["secrets"].as_array().unwrap() {
            assert!(!result.text.contains(secret.as_str().unwrap()));
        }
        for _ in 0..5 {
            black_box(engine.redact(black_box(input)).unwrap());
        }
        let mut samples = Vec::new();
        for _ in 0..21 {
            let start = Instant::now();
            for _ in 0..3 {
                black_box(engine.redact(black_box(input)).unwrap());
            }
            samples.push(start.elapsed().as_secs_f64() * 1000.0 / 3.0);
        }
        let mut sorted = samples.clone();
        sorted.sort_by(f64::total_cmp);
        let p50 = sorted[10];
        let p95 = sorted[19];
        rows.push(json!({"id":task["id"],"implementation":"local-rust-core",
            "constructionMs":construction_ms,"samplesMs":samples,"p50Ms":p50,"p95Ms":p95,
            "throughputMiBs":input.len() as f64 / 1048576.0 / (p50 / 1000.0),
            "correctness":"passed"}));
    }
    println!("{}", serde_json::to_string(&rows).unwrap());
}
