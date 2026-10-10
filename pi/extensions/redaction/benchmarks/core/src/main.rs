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
        let checks = task["coreChecks"].as_array().unwrap();
        let inputs: Vec<&str> = checks
            .iter()
            .map(|check| check["text"].as_str().unwrap())
            .collect();
        let start = Instant::now();
        let mut engine = Engine::from_json(&config).unwrap();
        let construction_ms = start.elapsed().as_secs_f64() * 1000.0;
        for check in checks {
            let result = engine.redact(check["text"].as_str().unwrap()).unwrap();
            assert_eq!(result.text, check["output"].as_str().unwrap());
            assert_eq!(
                result.matches.len(),
                check["matches"].as_u64().unwrap() as usize
            );
        }
        let multi = matches!(task["shape"].as_str(), Some("multi-text" | "nested"));
        let mut index = 0;
        let mut run = || {
            if multi {
                for input in &inputs {
                    black_box(engine.redact(black_box(input)).unwrap());
                }
            } else {
                black_box(
                    engine
                        .redact(black_box(inputs[index % inputs.len()]))
                        .unwrap(),
                );
                index += 1;
            }
        };
        let start = Instant::now();
        let mut warmup = 0;
        while warmup < 20 || start.elapsed().as_secs_f64() < 0.05 {
            run();
            warmup += 1;
        }
        let mut batch = 1;
        loop {
            let start = Instant::now();
            for _ in 0..batch {
                run();
            }
            if start.elapsed().as_secs_f64() >= 0.005 || batch == 8192 {
                break;
            }
            batch *= 2;
        }
        let mut samples = Vec::new();
        for _ in 0..21 {
            let start = Instant::now();
            for _ in 0..batch {
                run();
            }
            samples.push(start.elapsed().as_secs_f64() * 1000.0 / batch as f64);
        }
        let mut sorted = samples.clone();
        sorted.sort_by(f64::total_cmp);
        rows.push(json!({"id":task["id"],"implementation":"local-rust-core",
            "constructionMs":construction_ms,"warmupIterations":warmup,"batch":batch,
            "samplesMs":samples,"p50Ms":sorted[10],"p95Ms":sorted[19],
            "minMs":sorted[0],"maxMs":sorted[20],"correctness":"passed"}));
    }
    println!("{}", serde_json::to_string(&rows).unwrap());
}
