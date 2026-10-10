//! Synthetic hot-core benchmark, no fixture generation or private inputs.
use pi_redaction::Engine;
use std::hint::black_box;
use std::time::Instant;

fn main() {
    let mut engine = Engine::from_json(
        r#"{"literals":{"synthetic-person":"PERSON"},"detectors":{"email":true}}"#,
    )
    .unwrap();
    let input = "ordinary line synthetic-person a@example.test unicode🙂\n".repeat(1024);
    let expected = engine.redact(&input).unwrap();
    assert_eq!(expected.matches.len(), 2048);
    assert_eq!(engine.redact(&expected.text).unwrap().text, expected.text);
    let iterations = 200;
    let start = Instant::now();
    for _ in 0..iterations {
        black_box(engine.redact(black_box(&input)).unwrap());
    }
    let seconds = start.elapsed().as_secs_f64();
    println!(
        "synthetic hot Rust core: {} bytes x {iterations}, {:.2} MiB/s, {:.2} us/scan",
        input.len(),
        (input.len() * iterations) as f64 / seconds / 1048576.0,
        seconds * 1e6 / iterations as f64
    );
}
